var fs = require('fs');
var EventEmitter = require('events');
var util = require('util');
var crypto = require('crypto');
var _ = require('lodash')
var udp = require('dgram');

var mod = module.exports = function() {};

console.passthru = function(method) {
  return function() {
    var args = Array.prototype.slice.call(arguments, 0);
    console[method].apply(console, args);
    if(args.length == 1)
      return args[0];
    return args;
  };
};

mod.hashthing = hashthing;
mod.encrypt = encryptThing;
mod.decrypt = decryptThing;
mod.send = function(msg, port, address, cb) {
  var c = udp.createSocket('udp4');
  c.send(msg, 0, msg.length, port, address, cb || function() {
    c.close();
  });
};
function hashthing(content, algo) {
  var hashc = crypto.createHash(algo || 'sha256');
  return xThing(hashc,content).then(function(hashed) {
    return hashed.toString('hex');
  });
};

function xThing(c, buf) {
  return new Promise(function(resolve, reject) {
    var parts = [];
    c.on("readable", function() {
      var d = c.read();
      if(!!d)
        parts.push(d);
    });
    c.on('end', function() {
      resolve(Buffer.concat(parts));
    });
    c.on('error', reject);
    c.write(buf);
    c.end();
  });
}

function encryptThing(key, buf) {
  var cipher = crypto.createCipher('AES256', key);
  cipher.setAutoPadding(true);
  return xThing(cipher, buf);
}

function decryptThing(key, buf) {
  var decipher = crypto.createDecipher('AES256', key);
  decipher.setAutoPadding(true);
  return xThing(decipher, buf);
}

function hashlist(filename, enckey, idContent, opts) {
  opts || (opts = {});

  opts = _.defaults(opts, {
    tryLocalFile: false,
    skipFileRead: false,
    size: -1
  });

  return new Promise(function(resolve, reject) {
    var rf = fs.readFile;

    if(!!opts.skipFileRead)
      rf = function(fn, cb) {
        cb(null, new Buffer());
      };
    fs.readFile(filename, function(err, data) {

      var ignoreMissingFile = opts.skipFileRead || opts.tryLocalFile;
      //if(!!err)
      //  return reject(err);
      var fileSize = data && !!!err ? data.length : opts.size;

      if(fileSize == 0 && !!!err && !ignoreMissingFile)
        return resolve([]);

      if(fileSize < 0)
        reject("Invalid filesize");

      var chunks = [];
      if(!!err)
        return reject(err);
      var r = [];
      var chunkSize = 1024*128; //128KB;

      for(var i = 0; i < fileSize; i += chunkSize) {
        var id = [i].concat(idContent).join("-");
        var encrypted = (ignoreMissingFile && !err) ? Promise.resolve("") : encryptThing(enckey, data.slice(i, i+chunkSize));

        var encryptedHash = (ignoreMissingFile && !err) ? hashthing([i,enckey,i,Date.now()].join("")) : encrypted.then(function(buff) {
          return hashthing(buff);
        });

        chunks.push(Promise.all([
          hashthing(id),
          encrypted,
          encryptedHash,
          Promise.resolve(i) //start offset
        ]));
      }

      Promise.all(chunks).then(function(cs) {
        return _.map(cs, function(p) {
          return {
            id: p[0],
            content: p[1],
            hash: p[2],
            start: p[3]
          };
        });
      }).then(resolve).catch(reject);
    });
  });
};

var client = function(dir, id, encryptkey) {
  var self = this;
  self.dir = dir;
  self.id = id;
  self._watcher = fs.watch(self.dir, {recursive: true}, self._fschange.bind(self));
  self._encryptKey = encryptkey;
  self._server = udp.createSocket({type: 'udp4'});

  self.on('udp:message', function(m, r) {
    try {
      var o = JSON.parse(m.toString('utf8'));
      //o {f, id, content};
      if(!!o.f && !!o.id && !!o.content)
        self.emit('message:enciphered', o, r);
      else if(!!o.type)
        self.emit('message:cmd', o, r);
    } catch(ex) {}
  });

  self.on('message:enciphered', (function(msg) {
    if(!!!this._encryptKey) {
      //flat file save
      return;
    }

    //decrypt and save to disk

  }).bind(self));

  self._neighbors = {};
  self.on('message:cmd', function(msg, r) {
    switch(msg.type) {
      case 'iam':
        self._neighbors[msg.iam] = r;
        self.emit('neighbor', msg, r);
        break;
      case 'file:new':
        self.emit('file:new', msg);
        break;
      case 'file:delete':
        self.emit('file:delete', msg);
        break;
      case 'file:content':
        break;
      default:
        if(_.includes(self.eventNames(), msg.type))
          self.emit(msg.type, msg, r);
    }
  });

  self._neighbors = {};
  self.on("neighbor", function(remote, ur) {
    var k = [remote.address, remote.port].join(":")
    if(typeof self._neighbors[k] == 'undefined') {
      self._neighbors[k] = remote;
      remote.send = function(data) {
        mod.send(this.port, this.address, new Buffer(JSON.stringify(data), 'utf8'));
      };
      self.emit('neighbor:new', remote);
    }
  });

  //toss this? meaningless
  self.on('file:sync', function(chunksPromise) {
    chunksPromise.then(function(chunks) {
      var f = function(c, msg) {
        //this will stick around if no peers have the piece
        //will need a way to cleanup old event stuff.
        if(!!msg.err)
          self.once('file:sync:'+c.id, f.bind(null, c));
        var c = _.find(chunks, ['id', msg.id]);
        c.content = msg.content;
        //stream to file;
      };

      _.each(chunks, function(c) {
        //need delay
        self.once('file:sync:'+c.id, f.bind(null, c));
        _.each(self._neighbors, function(n) {
          //ask for parts
          n.send({
            type: 'piece:request',
            id: c.id,
            //encrypted hint for trusted peers?
          });
        });
      });
    });
  });

  self.on('file:remotechange', function(file) {
    decryptThing(self._encryptKey, new Buffer(file.meta, 'base64')).then(function(data) {
      try {
        var o = JSON.parse(data.toString('utf8'));
        //o.filename
        //o.id
        //o.size
        //o.lastmod
        //o.chunks
          //o.chunks[].id
          //o.chunks[].hash
        var chunks = hashlist(o.filename, self._encryptKey, [o.filename, self._encryptKey], {tryLocalFile: true, size: o.size});
        chunks.then(function(chunks) {
          var rawdiff = _.uniqBy(_.xorBy(chunks, o.chunks, function(x) { return x.id + x.hash; }), 'id');
          //req differences.
          var realdiff = _.map(rawdiff, function(d) {
            var remotedets = _.find(o.chunks, ['id', d.id]);
            var localdets = _.find(chunks, ['id', d.id]);
            return _.defaults(remotedets, localdets);
          });
          var fn = self.dir+'/'+o.filename;
          fs.open(fn, 'a', function(err, fh) {
            _.each(realdiff, function(chunk) {
              self.requestPiece(fh, chunk);
              //fileHandle, chuckInfo, peerHint
            });
          });
        });
      } catch(ex) { }
    }).catch(console.error.bind("file:remotechange decryption error"));
  });

  self.on('request:piece', function(msg) {

  });
};

util.inherits(client, EventEmitter);
client.prototype._fschange = function(eventType, filename) {

  this.emit('filewatch', eventType, filename);

  hashlist(this.dir + '/' + filename, this._encryptKey, [filename, this._encryptKey]).then(this.emit.bind(this, 'encryptedChunks'));
};

client.prototype.sorted = function(o) {
  return _.sortBy(o, 'id');
};

client.prototype.listen = function() {
  var args = Array.prototype.slice.call(arguments, 0);
  this._server.bind.apply(this._server, args);
  this._server.on('listening', this.emit.bind(this, 'udp:listening'));
  this._server.on('message', this.emit.bind(this, 'udp:message'));
  return this;
};

client.prototype.requestPiece = function(fileHandle, chuckInfo, peerHint) {
  var self = this;
  var peers = this._neighbors;
  if(!!peerHint)
    peers = [peerHint];

  function processReply(peer, fh, chunk, msg) {
    var self = this;
    var eventName = "piece:" + chunk.id +':'+chunk.hash;
    var eventExists = _.includes(self.eventNames(), eventName);
    switch (true) {
      case !!msg.inital && !eventExists:
      case !msg.inital && !eventExists:
        self.on(eventName, processReply.bind(self, peer, fh, chunk));
        break;
      default:
    }
    if(!!msg.content) {
      decryptThing(self._encryptKey, new Buffer(msg.content, 'base64')).then(function(raw) {
        hashthing(raw).then(function(contenthash) {
          if(contenthash != chunk.hash)
            return;
          self.remoteAllListeners(eventName);
          fs.write(fh, raw, 0, raw.length, chunk.start, function() {});
        });
      });
    }
  };

  _.each(peers, function(peer) {
    var pr = processReply.bind(self, peer, fileHandle, chuckInfo);
    pr({inital: true});
    mod.send({
      type: 'request:piece',
      replyto: self.id,
      id: chuckInfo.id,
      hash: chuckInfo.hash
    });
  });
};

client.prototype.connectTo = function(address,port) {
  var self = this;
  var realaddress, realport;
  if(/:/.test(address)) {
    realport = address.split(":")[1]
    realaddress = address.split(":")[0];
  }
  self._neighbors[realaddress+':'+realport] = {};
  var selfid = [self._server.address().address, self._server.address().port].join(":");
  mod.send(new Buffer(JSON.stringify({
    type: 'iam',
    iam: selfid
  }), 'utf8'), realport, realaddress);
};


mod.createClient = function(dir, id, encryptkey) {
  return new client(dir, id, encryptkey);
}
