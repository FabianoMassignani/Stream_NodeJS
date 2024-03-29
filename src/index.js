const express = require("express");
const http = require("http");
let LocalStorage = require("node-localstorage").LocalStorage;
let localStorage = new LocalStorage("./localStorage");
const cors = require("cors");
const pretty = require("prettysize");
const async = require("async");
const { address } = require("ip");
const magnetUri = require("magnet-uri");
const mime = require("mime");
const pump = require("pump");
const rangeParser = require("range-parser");
const streamMeter = require("stream-meter");
const torrentStream = require("torrent-stream");

const port = 3001;

const app = express();

app.set("json spaces", 2);
app.use(express.json());
app.use(cors());

http.createServer(app);

const subtitleRouter = require("./routes/subtitle");
const torrentsRouter = require("./routes/torrents");

app.listen(port, () => {
  const ipAddress = address();
  process.env.HOST = "0.0.0.0";
  console.log(`Servidor iniciado em http://${ipAddress}:${port}`);
});

let PRELOAD_RATIO = 0.001;
let inactivityPauseTimeout = 3;
let inactivityRemoveTimeout = 5;
let keep = false;
const torrents = {};


app.use("/subtitle", subtitleRouter);
app.use("/torrent", torrentsRouter);

app.get("/", function (req, res) {
  let torrents = [];

  for (const infoHash in torrents) {
    torrents.push(torrents[infoHash].getInfo());
  }

  res.json(torrents);
});

app.get("/shutdown", function (req, res) {
  async.forEachOf(
    torrents,
    function (value, key, callback) {
      value.destroy(callback);
    },

    function () {
      console.log("Stopping");
      process.exit();
    }
  );
});

app.get("/add", function (req, res) {
  var torrent = addTorrent(req.query.magnet_link);

  torrent.addConnection();

  req.on("close", function () {
    torrent.removeConnection();
  });

  req.on("end", function () {
    torrent.removeConnection();
  });

  res.json(torrent.getInfo());
});

app.get("/video", function (req, res) {
  var torrent = addTorrent(req.query.magnet_link);

  torrent.addConnection();

  req.on("close", function () {
    torrent.removeConnection();
  });

  req.on("end", function () {
    torrent.removeConnection();
  });

  switch (torrent.state) {
    case "downloading":
    case "finished":
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader(
        "Content-Type",
        mime.lookup.bind(mime)(torrent.mainFile.name)
      );
      res.setHeader("transferMode.dlna.org", "Streaming");
      res.setHeader(
        "contentFeatures.dlna.org",
        "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000"
      );

      var range = req.headers.range;
      range = range && rangeParser(torrent.mainFile.length, range)[0];

      torrent.meter = streamMeter();
      torrent.meterInterval = setInterval(function () {
        if (torrent.meter.bytes > 10 * 1024 * 1024) {
          clearInterval(torrent.meterInterval);
          if (!torrent.serving) {
            torrent.serving = true;
            console.log(torrent.dn + ": SERVING");
          }
        }
      }, 1000);

      if (!range) {
        res.setHeader("Content-Length", torrent.mainFile.length);
        pump(torrent.mainFile.createReadStream(), torrent.meter, res);
      } else {
        res.status(206);
        res.setHeader("Content-Length", range.end - range.start + 1);
        res.setHeader(
          "Content-Range",
          "bytes " +
            range.start +
            "-" +
            range.end +
            "/" +
            torrent.mainFile.length
        );
        pump(torrent.mainFile.createReadStream(range), torrent.meter, res);
      }

      break;
    case "failed":
      res.sendStatus(404);
      break;
    case "metadata":
      setTimeout(function () {
        res.redirect(307, req.url);
      }, 1000);
      break;
  }
});

function addTorrent(magnetLink) {
  var magnetData = magnetUri.decode(magnetLink);

  if (!(magnetData.infoHash in torrents)) {
    var torrent = {
      engine: torrentStream(magnetLink, { path: "." }),
      dn: magnetData.dn,
      infoHash: magnetData.infoHash,
      state: "metadata",
      connections: 0,
      paused: false,
      pieceMap: [],
    };

    torrent.addConnection = function () {
      this.connections++;

      if (this.mainFile && this.paused) {
        this.mainFile.select();
        this.paused = false;
        console.log(this.dn + ": RESUMED");
      }

      clearTimeout(this.pauseTimeout);
      clearTimeout(this.removeTimeout);
    };

    torrent.removeConnection = function () {
      this.connections--;

      if (this.connections == 0) {
        var self = this;
        this.pauseTimeout = setTimeout(function () {
          if (self.mainFile && !self.paused) {
            self.mainFile.deselect();
            self.paused = true;
            console.log(self.dn + ": PAUSED");
          }
          self.removeTimeout = setTimeout(function () {
            self.destroy();
          }, inactivityRemoveTimeout * 1000);
        }, inactivityPauseTimeout * 1000);
      }

      clearTimeout(this.servingTimeout);
    };

    torrent.getInfo = function () {
      var info = {
        dn: this.dn,
        info_hash: this.infoHash,
        state: this.state,
        paused: this.paused,
        downloaded: this.engine.swarm.downloaded,
        uploaded: this.engine.swarm.uploaded,
        download_speed: this.engine.swarm.downloadSpeed() / 1024,
        upload_speed: this.engine.swarm.uploadSpeed() / 1024,
        peers: this.engine.swarm.wires.length,
      };

      if (this.state == "downloading" || this.state == "finished") {
        info.files = [];

        var self = this;
        this.engine.files.forEach(function (file) {
          info.files.push({
            path: file.path,
            size: file.length,
            main: file.path == self.mainFile.path,
          });
        });

        info.pieces = this.engine.torrent.pieces.length;
        info.pieces_preload = Math.round(info.pieces * PRELOAD_RATIO);
        info.piece_length = this.engine.torrent.pieceLength;
        info.piece_map = Array(Math.ceil(info.pieces / 100));

        for (var i = 0; i < info.piece_map.length; i++) info.piece_map[i] = "";

        for (var i = 0; i < info.pieces; i++)
          info.piece_map[Math.floor(i / 100)] += this.pieceMap[i];

        info.video_ready = this.pieceMap[info.pieces - 1] == "*";
        for (var i = 0; i < info.pieces_preload; i++) {
          if (this.pieceMap[i] != "*") {
            info.video_ready = false;
          }
        }
      }

      return info;
    };

    torrent.engine.on("verify", function (pieceIndex) {
      torrent.pieceMap[pieceIndex] = "*";
    });

    torrent.engine.on("idle", function () {
      if (torrent.state == "downloading" && !torrent.paused) {
        torrent.state = "finished";

        console.log(torrent.dn + ": FINISHED");
      }
    });

    torrent.destroy = function (callback) {
      var self = this;
      this.engine.destroy(function () {
        console.log(self.dn + ": REMOVED");

        if (!keep) {
          self.engine.remove(function () {
            console.log(self.dn + ": DELETED");
            delete torrents[self.infoHash];
            if (callback) callback();
          });
        } else {
          delete torrents[self.infoHash];
          if (callback) callback();
        }
      });
    };

    torrent.engine.on("ready", function () {
      torrent.state = "downloading";

      // Select main file
      torrent.engine.files.forEach(function (file) {
        if (!torrent.mainFile || torrent.mainFile.length < file.length)
          torrent.mainFile = file;
      });
      torrent.mainFile.select();
      torrent.engine.select(
        0,
        Math.round(torrent.engine.torrent.pieces.length * PRELOAD_RATIO),
        true
      );
      torrent.engine.select(
        torrent.engine.torrent.pieces.length - 1,
        torrent.engine.torrent.pieces.length - 1,
        true
      );

      // Initialize piece map
      for (var i = 0; i < torrent.engine.torrent.pieces.length; i++)
        if (!torrent.pieceMap[i]) torrent.pieceMap[i] = ".";

      clearTimeout(torrent.metadataTimeout);
      console.log(torrent.dn + ": METADATA RECEIVED");
    });

    torrent.metadataTimeout = setTimeout(function () {
      torrent.state = "failed";
      console.log(torrent.dn + ": METADATA FAILED");
    }, 20000);

    torrents[torrent.infoHash] = torrent;

    console.log(torrent.dn + ": ADDED");
  }

  return torrents[magnetData.infoHash];
}
