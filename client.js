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
    console.log("passthru args", args);
    console[method].apply(console, args);
    if((args.length || 0) == 1)
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
function hashthing(content, algo, outformat) {
  var hashc = crypto.createHash(algo || 'sha256');
  return xThing(hashc,content).then(function(hashed) {
    return hashed.toString(outformat || 'hex');
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
function hashlist(uopts) {
  var opts = _.defaults(uopts, {
    realfilename: "",
    relfilename: "",
    cipherkey: "",
    addOffsetHashContent: [],
    size: -1,
    chunkSize: 1024*128, //128KB
    ignoreMissing: true, //if true, size needs to be set too or errors out
    onlyOffsetHashes: false, // will only calculate offset hashs. forces skipFileRead = true
    skipFileRead: false, //forces skipContentHash & skipEncHash=true
    skipContent: false, //won't return encrypted chunks, will still read the file
    skipContentHash: false, //won't return hashs for pre-encrypted data
    skipEncHash: false //won't return hashs on encrypted data
  });


  var fSize = opts.size;
  var noContent = false;

  return new Promise(function haslistPromise(resolve, reject) {
    var obj = {
      filename: opts.relfilename,
      size: -1,
      chunks: []
    };

    var readFile = fs.readFile;
    switch(true) {
      case opts.onlyOffsetHashes:
      case opts.skipFileRead:
        opts.skipContentHash = true;
        opts.skipEncHash = true;
        readFile = function(file, cb) {
          noContent = true;
          cb(null, new Buffer([]));
        };
        break;
    }
    var fileRawContent = new Promise(function(resolve, reject) {
      readFile(opts.realfilename, function (err, data) {
        if(!!err && !!opts.ignoreMissing && fSize > -1) {
          return resolve([]);
        } else if(!!err) {
          return reject(err);
        }
        fSize = data.length;
        resolve(data);
      });
    }).catch(reject);

    var chunks = fileRawContent.then(function(fbuf) {
      return new Promise(function hashlistChunkSplitter(resolve, reject) {
        var chunksPromises = []
        for(var i = 0; i < fSize; i += opts.chunkSize) {
          var offestHash = Promise.resolve(""),
            rawHash = Promise.resolve(""),
            ciphered = Promise.resolve(""),
            cipheredHash = Promise.resolve();

          offsetHash = hashthing([opts.relfilename, i, opts.cipherkey, ].concat(opts.addOffsetHashContent).join('-'));

          if(!opts.onlyOffsetHashes && !noContent) {
            var fbufchunk = fbuf.slice(i, i+opts.chunkSize);
            if(!opts.skipContentHash)
              contenthash = hashthing(fbufchunk);

            if(!opts.skipContent)
              ciphered = encryptThing(opts.cipherkey, fbufchunk);

            if(!opts.skipEncHash)
              cipheredHash = ciphered.then(function(ch) {
                return hashthing(ch);
              });
          }

          chunksPromises.push(Promise.all([
            Promise.resolve(i),
            offsetHash,
            contenthash,
            ciphered,
            cipheredHash
          ]));
        }
        Promise.all(chunksPromises).then(function hashlistChunkMapper(chunksInfo) {
          resolve(_.map(chunksInfo, function(i) {
            return {
              o: i[0],
              ohash: i[1],
              rhash: i[2],
              c: i[3],
              chash: i[4]
            };
          }));
        }).catch(reject);
      });
    }); //end chunks
    chunks.then(function hashlistChunkMeta(chunksInfo) {
      resolve({
        filename: opts.relfilename,
        size: fSize,
        id: "",
        lastmod: 0,
        chunks: chunksInfo
      });
    }).catch(reject);
  });//end main Promise
} //end hashlist

var client = function Client(dir, id, encryptkey) {
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

  self.on('file:remotechange', function(msg) {
    decryptThing(self._encryptKey, new Buffer(msg.meta, 'base64')).then(function(data) {
      try {
        var o = JSON.parse(data.toString('utf8'));
        //o.filename
        //o.id
        //o.size
        //o.lastmod
        //o.chunks
          //o.chunks[].id
          //o.chunks[].hash
        var chunks = hashlist({
          filename: o.filename,
          cipherkey: self._encryptKey,
          size: o.size,
        });
        chunks.then(function(info) {
          var diff1 = _.uniqBy(_.xorBy(info.chunks, o.chunks, function(x) {
            return x.ohash + ohash;
          }), 'ohash');
          var fdiff = _.map(diff1, function(d) {
            var remotedets = _.find(o.chunks, ['ohash', d.ohash]);
            var localdets = _.find(d.chunks, ['ohash', d.ohash]);
            return _.defaults(remotedets, localdets);
          });

          var realfilename = self.dir + '/' + o.filename;

          fs.open(realfilename, function(err, fh) {
            _.each(fdiff, function(chunk) {
              self.requestPiece(fh, chunk);
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

  //hashlist(this.dir + '/' + filename, this._encryptKey, [filename, this._encryptKey]).then(this.emit.bind(this, 'encryptedChunks'));
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

client.prototype._genMeta = function(filepath) {
  var meta = {
    file: filepath,
  };
  return hashlist({
    realfilename: this.dir + '/' + filepath,
    filename: filename,
    cipherkey: this._encryptKey,
    onlyOffsetHashes: true
  });
  //return hashlist(filepath, this._encryptKey, )
};
client.prototype.pushFileUpdate = function(file, chunks) {
  var self=  this;
  //o.filename
  //o.id
  //o.size
  //o.lastmod
  //o.chunks
    //o.chunks[].id
    //o.chunks[].hash
  //(filename, enckey, idContent, opts)
  return new Promise(function(resolve, reject) {
    var realpath = self.dir + "/" + file;
    fs.stat(realpath, function(err, stats) {
      var hlopts = {
        realfilename: realpath,
        file: file,
        cipherkey: self.encryptkey
      };
      //console.log("asdfasdf")
      hashlist(hlopts).then(function(meta) {
        console.log(meta);
      }).then(resolve).catch(reject);
    });
  });
  /*
  fs.stat(file, function(err, stats) {
    hashlist(file, this._encryptKey,  [file, this._encryptKey], {noContent: true}).then(function(chunks) {
      var meta = {
        filename: file,
        id: "",
        size: stats.size, //need to get file size  somehow
        lastmod: 0,
        chunks: chunks
      };
      encryptThing(self._encryptKey, new Buffer(JSON.stringify(meta), 'base64')).then(function(enmeta) {
        var msg = {
          type: 'file:remotechange'
          meta: enmeta
        };
        //send to peers
      })
    });
  });
  */
};


mod.createClient = function(dir, id, encryptkey) {
  return new client(dir, id, encryptkey);
}
