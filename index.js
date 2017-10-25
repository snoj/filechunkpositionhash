var baseclient = require('./client');
var _ = require('lodash');

var allConnected = [];

var client1key, client1;
allConnected.push(new Promise(function(resolve, reject) {
  client1key = "somethingsometosngoasdg";
  client1 = baseclient.createClient("./test-repo/client1", "client1", client1key);
  client1.listen(5556, '127.0.0.1', function() { resolve(client1); });
}));

/*var client2key = "somethingsometosngoasdg";
var client2 = baseclient.createClient("./test-repo/client2", "client2", client2key);
client2.listen(5557, '127.0.0.1');*/

var client2key, client2;
allConnected.push(new Promise(function(resolve, reject) {
  client2key = "somethingsometosngoasdg";
  client2 = baseclient.createClient("./test-repo/client2", "client2", client2key);
  client2.listen(5557, '127.0.0.1', function() { resolve(client2); });
}));

var server;
allConnected.push(new Promise(function(resolve, reject) {
  server = baseclient.createClient("./test-repo/server", "server");
  server.listen(5555, '127.0.0.1', function() { resolve(server); });
}));
//var server = baseclient.createClient("./test-repo/server", "server");
//server.listen(5555, '127.0.0.1');

Promise.all(allConnected).then(function() {
  client1.connectTo('127.0.0.1:5555');
  client1.connectTo('127.0.0.1:5557');
  client2.connectTo('127.0.0.1:5555');
  client2.connectTo('127.0.0.1:5556');
  server.connectTo('127.0.0.1:5556');
  server.connectTo('127.0.0.1:5557');
  //client1.on('filewatch', console.log);
  client1.on('encryptedChunks', function(c) {
    console.log(_.map(client1.sorted(c), function(v) {
      return v; //{id: v.id, hash: v.hash};
    }));
  });

  client1.on('message:cmd', console.log);

});
