var baseclient = require('./client');
var _ = require('lodash');

var client1key = "somethingsometosngoasdg";
var client1 = baseclient.createClient("./test-repo/client1", "client1", client1key);

//client1.on('filewatch', console.log);
client1.on('encryptedChunks', function(c) {
  //console.log("one", _.map(c, 'id'));
  //console.log("two", _.map(_.sortBy(c, 'id'),'id'));
  console.log(_.map(client1.sorted(c), function(v) {
    return v; //{id: v.id, hash: v.hash};
  }));
});

client1.on('message:cmd', console.log);
client1.on('file:new', console.log.bind(null, "file:new"));
client1.listen(5555, '127.0.0.1', function() {
  //console.log("binded", arguments);
});

if(false)
  setInterval(function() {

    console.log("tadfsdfsd")
    var c = {type: "file:new"};
    baseclient.encrypt(client1key, new Buffer(JSON.stringify({filename: "test1111", id: "190878013780175"}), 'utf8')).then(function(meta) {
      c.meta = meta.toString('base64');
      var m = new Buffer(JSON.stringify(c), 'utf8');
      baseclient.send(m, 5555, '127.0.0.1');
    })

  }, 1000);
