/*
The MIT License (MIT)
Copyright (c) 2013 Calvin Montgomery
 
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

var fs = require("fs");
var mysql = require("mysql-libmysqlclient");
var Config = require("./config.js");
var Rank = require("./rank.js");
// I should use the <noun><verb>er naming scheme more often
var InfoGetter = require("./get-info.js");
var Media = require("./media.js").Media;
var ChatCommand = require("./chatcommand.js");
var Server = require("./server.js");
var io = Server.io;
var Logger = require("./logger.js");
var Poll = require("./poll.js").Poll;

var Channel = function(name) {
    Logger.syslog.log("Opening channel " + name);
    this.name = name;
    this.registered = false;
    this.users = [];
    this.queue = [];
    this.library = {};
    this.currentPosition = -1;
    this.currentMedia = null;
    this.leader = null;
    this.recentChat = [];
    this.qlocked = true;
    this.poll = false;
    this.voteskip = false;
    this.opts = {
        qopen_allow_qnext: false,
        qopen_allow_move: false,
        qopen_allow_playnext: false,
        qopen_allow_delete: false,
        allow_voteskip: true,
        pagetitle: "Sync",
        customcss: ""
    };
    this.filters = [
        [/`([^`]+)`/g          , "<code>$1</code>"    , true],
        [/\*([^\*]+)\*/g       , "<strong>$1</strong>", true],
        [/(^| )_([^_]+)_/g     , "$1<em>$2</em>"      , true],
        [/\\\\([-a-zA-Z0-9]+)/g, "[](/$1)"            , true]
    ];
    this.motd = {
        motd: "",
        html: ""
    };

    this.ipbans = {};
    this.logger = new Logger.Logger("chanlogs/" + this.name + ".log");
    fs.readFile("chandump/" + this.name, function(err, data) {
        if(err) {
            return;
        }
        try {
            this.logger.log("*** Loading channel dump from disk");
            data = JSON.parse(data);
            for(var i = 0; i < data.queue.length; i++) {
                var e = data.queue[i];
                this.queue.push(new Media(e.id, e.title, e.seconds, e.type));
            }
            this.sendAll("playlist", {
                pl: this.queue
            });
            this.currentPosition = data.currentPosition - 1;
            if(this.currentPosition < -1)
                this.currentPosition = -1;
            if(this.queue.length > 0)
                this.playNext();
            this.opts = data.opts;
            if(data.filters) {
                this.filters = new Array(data.filters.length);
                for(var i = 0; i < data.filters.length; i++) {
                    this.filters[i] = [new RegExp(data.filters[i][0]),
                                       data.filters[i][1],
                                       data.filters[i][2]];
                }
            }
            if(data.motd) {
                this.motd = data.motd;
            }
        }
        catch(e) {
            Logger.errlog.log("Channel dump load failed: ");
            Logger.errlog.log(e);
        }
    }.bind(this));

    // Autolead stuff
    // Accumulator
    this.i = 0;
    // Time of last update
    this.time = new Date().getTime();

    this.loadMysql();
};

// Check if this channel is registered
// If it is, fetch the library
Channel.prototype.loadMysql = function() {
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.loadMysql: MySQL Connection Failed");
        return false;
    }
    // Check if channel exists
    var query = "SELECT * FROM channels WHERE name='{}'"
        .replace(/\{\}/, this.name);
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: Channel query failed");
        return;
    }
    var rows = results.fetchAllSync();
    if(rows.length == 0) {
        Logger.syslog.log("Channel " + this.name + " is unregistered.");
        return;
    }
    // [](/picard) I didn't realize that MySQL wasn't case sensitive.
    // My bad.
    else if(rows[0].name != this.name) {
        this.name = rows[0].name;
    }
    this.registered = true;

    // Load library
    var query = "SELECT * FROM chan_{}_library"
        .replace(/\{\}/, this.name);
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: failed to load library for " + this.name);
        return;
    }
    var rows = results.fetchAllSync();
    for(var i = 0; i < rows.length; i++) {
        this.library[rows[i].id] = new Media(rows[i].id, rows[i].title, rows[i].seconds, rows[i].type);
    }

    // Load bans
    var query = "SELECT * FROM chan_{}_bans"
        .replace(/\{\}/, this.name);
    var results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.loadMysql: failed to load banlist for " + this.name);
        return;
    }
    var rows = results.fetchAllSync();
    for(var i = 0; i < rows.length; i++) {
        this.ipbans[rows[i].ip] = [rows[i].name, rows[i].banner];
    }

    Logger.syslog.log("Loaded channel " + this.name + " from database");
    db.closeSync();
}

// Creates a new channel record in the MySQL Database
// Currently unused, but might be useful if I add a registration page
Channel.prototype.createTables = function() {
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.createTables: DB connection failed");
        return false;
    }
    // Create library table
    var query= "CREATE TABLE `chan_{}_library` \
                    (`id` VARCHAR(255) NOT NULL, \
                    `title` VARCHAR(255) NOT NULL, \
                    `seconds` INT NOT NULL, \
                    `playtime` VARCHAR(8) NOT NULL, \
                    `type` VARCHAR(2) NOT NULL, \
                    PRIMARY KEY (`id`)) \
                    ENGINE = MyISAM;"
        .replace(/\{\}/, this.name);
    var results = db.querySync(query);

    // Create rank table
    var query = "CREATE TABLE  `chan_{}_ranks` (\
                    `name` VARCHAR( 32 ) NOT NULL ,\
                    `rank` INT NOT NULL ,\
                    UNIQUE (\
                    `name`\
                    )\
                    ) ENGINE = MYISAM"
        .replace(/\{\}/, this.name);
    results = db.querySync(query) || results;

    // Create ban table
    var query = "CREATE TABLE  `chan_{}_bans` (\
                    `ip` VARCHAR( 15 ) NOT NULL ,\
                    `name` VARCHAR( 32 ) NOT NULL ,\
                    `banner` VARCHAR( 32 ) NOT NULL ,\
                    PRIMARY KEY (\
                    `ip`\
                    )\
                    ) ENGINE = MYISAM"
        .replace(/\{\}/, this.name);
    results = db.querySync(query) || results;

    // Insert into global channel table
    var query = "INSERT INTO channels (`id`, `name`) VALUES (NULL, '{}')"
        .replace(/\{\}/, this.name);
    results = db.querySync(query) || results;
    db.closeSync();
    return results;
}

Channel.prototype.tryRegister = function(user) {
    if(this.registered) {
        user.socket.emit("registerChannel", {
            success: false,
            error: "This channel is already registered"
        });
    }
    else if(!user.loggedIn) {
        user.socket.emit("registerChannel", {
            success: false,
            error: "You must log in to register a channel"
        });

    }
    else if(!Rank.hasPermission(user, "registerChannel")) {
        user.socket.emit("registerChannel", {
            success: false,
            error: "You don't have permission to register this channel"
        });
    }
    else {
        if(this.createTables()) {
            this.registered = true;
            this.saveRank(user);
            user.socket.emit("registerChannel", {
                success: true,
            });
            this.logger.log("*** " + user.name + " registered the channel");
            Logger.syslog.log("Channel " + this.name + " was registered by " + user.name);
        }
        else {
            user.socket.emit("registerChannel", {
                success: false,
                error: "Unable to register channel, see an admin"
            });
        }
    }
}

// Retrieves a user"s rank from the database
Channel.prototype.getRank = function(name) {
    if(!this.registered)
        return Rank.Guest;
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.getRank: DB connection failed");
        return Rank.Guest;
    }
    var query = "SELECT * FROM chan_{1}_ranks WHERE name='{2}'"
        .replace(/\{1\}/, this.name)
        .replace(/\{2\}/, name);
    var results = db.querySync(query);
    if(!results)
        return Rank.Guest;
    var rows = results.fetchAllSync();
    if(rows.length == 0) {
        return Rank.Guest;
    }

    db.closeSync();
    return rows[0].rank;
}

// Saves a user"s rank to the database
Channel.prototype.saveRank = function(user) {
    if(!this.registered)
        return false;
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.saveRank: DB connection failed");
        return false;
    }
    var query = "UPDATE chan_{1}_ranks SET rank='{2}' WHERE name='{3}'"
        .replace(/\{1\}/, this.name)
        .replace(/\{2\}/, user.rank)
        .replace(/\{3\}/, user.name);
    var results = db.querySync(query);
    // Gonna have to insert a new one, bugger
    if(!results.fetchAllSync) {
        var query = "INSERT INTO chan_{1}_ranks (`name`, `rank`) VALUES ('{2}', '{3}')"
            .replace(/\{1\}/, this.name)
            .replace(/\{2\}/, user.name)
            .replace(/\{3\}/, user.rank);
        results = db.querySync(query);
    }
    db.closeSync();
    return results;
}

// Caches media metadata to the channel library.
// If the channel is registered, stores it in the database as well
Channel.prototype.addToLibrary = function(media) {
    this.library[media.id] = media;
    if(!this.registered)
        return;
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.addToLibrary: DB connection failed");
        return false;
    }
    var query = "INSERT INTO chan_{1}_library VALUES ('{2}', '{3}', {4}, '{5}', '{6}')"
        .replace(/\{1\}/, this.name)
        .replace(/\{2\}/, media.id)
        .replace(/\{3\}/, media.title)
        .replace(/\{4\}/, media.seconds)
        .replace(/\{5\}/, media.duration)
        .replace(/\{6\}/, media.type);
    var results = db.querySync(query);
    db.closeSync();
    return results;
}

Channel.prototype.banIP = function(banner, bannee) {
    // It is assumed that the banner has permission at this point
    this.ipbans[bannee.ip] = [bannee.name, banner.name];
    bannee.socket.disconnect();
    this.broadcastIpbans();
    if(!this.registered)
        return false;
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.banIP: DB connection failed");
        return false;
    }
    var query = "INSERT INTO chan_{1}_bans (`ip`, `name`, `banner`) VALUES ('{2}', '{3}', '{4}')"
        .replace(/\{1\}/, this.name)
        .replace(/\{2\}/, bannee.ip)
        .replace(/\{3\}/, bannee.name)
        .replace(/\{4\}/, banner.name);
    results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.banIP: Insert failed");
    }
    else {
        this.logger.log(bannee.ip + " (" + bannee.name + ") was banned by " + banner.name);
    }
    db.closeSync();
    return results;
}

Channel.prototype.unbanIP = function(ip) {
    this.ipbans[ip] = null;
    this.broadcastIpbans();

    if(!this.registered)
        return false;
    var db = mysql.createConnectionSync();
    db.connectSync(Config.MYSQL_SERVER, Config.MYSQL_USER,
                   Config.MYSQL_PASSWORD, Config.MYSQL_DB);
    if(!db.connectedSync()) {
        Logger.errlog.log("Channel.unbanIP: DB connection failed");
        return false;
    }

    var query = "DELETE FROM chan_{1}_bans WHERE `ip` = '{2}'"
        .replace(/\{1\}/, this.name)
        .replace(/\{2\}/, ip);

    results = db.querySync(query);
    if(!results) {
        Logger.errlog.log("Channel.unbanIP: Failed  to delete entry");
        return;
    }
    db.closeSync();
    return results;
}

// Searches the local library for media titles containing query
Channel.prototype.searchLibrary = function(query) {
    query = query.toLowerCase();
    var results = [];
    for(var id in this.library) {
        if(this.library[id].title.toLowerCase().indexOf(query) != -1) {
            results.push(this.library[id]);
        }
    }
    results.sort(function(a, b) {
        var x = a.title.toLowerCase();
        var y = b.title.toLowerCase();

        return (x == y) ? 0 : (x < y ? -1 : 1);
    });
    return results;
}

// Called when a new user enters the channel
Channel.prototype.userJoin = function(user) {
    if(user.ip in this.ipbans && this.ipbans[user.ip] != null) {
        this.logger.log("--- Kicking /" + user.ip + " - banned");
        user.socket.disconnect();
        return;
    }

    user.socket.join(this.name);
    // Prevent duplicate login
    if(user.name != "") {
        for(var i = 0; i < this.users.length; i++) {
            if(this.users[i].name == user.name) {
                user.name = "";
                user.loggedIn = false;
                user.socket.emit("login", {
                    success: false,
                    error: "The username " + user.name + " is already in use on this channel"
                });
            }
        }
    }
    // If the channel is empty and isn"t registered, the first person
    // gets ownership of the channel (temporarily)
    if(this.users.length == 0 && !this.registered) {
        user.rank = (user.rank < Rank.Owner) ? Rank.Owner + 7 : user.rank;
        user.socket.emit("channelNotRegistered");
    }
    this.users.push(user);
    if(user.name != "") {
        this.broadcastNewUser(user);
    }
    this.updateUsercount();
    // Set the new guy up
    this.sendPlaylist(user);
    user.socket.emit("queueLock", {locked: this.qlocked});
    this.sendUserlist(user);
    this.sendRecentChat(user);
    if(this.poll) {
        user.socket.emit("newPoll", this.poll.packUpdate());
    }
    user.socket.emit("channelOpts", this.opts);
    user.socket.emit("updateMotd", this.motd);
    if(user.playerReady)
        this.sendMediaUpdate(user);
    this.logger.log("+++ /" + user.ip + " joined");
    Logger.syslog.log("/" + user.ip + " joined channel " + this.name);
}

// Called when a user leaves the channel
Channel.prototype.userLeave = function(user) {
    try {
        user.socket.leave(this.name);
    }
    catch(e) {}
    if(this.poll) {
        this.poll.unvote(user.ip);
        this.broadcastPollUpdate();
    }
    if(this.leader == user) {
        this.changeLeader("");
    }
    var idx = this.users.indexOf(user);
    if(idx >= 0 && idx < this.users.length)
        this.users.splice(idx, 1);
    this.updateUsercount();
    if(user.name != "") {
        this.sendAll("userLeave", {
            name: user.name
        });
    }
    this.logger.log("--- /" + user.ip + " (" + user.name + ") left");
}

// Queues a new media
Channel.prototype.enqueue = function(data) {
    var idx = data.pos == "next" ? this.currentPosition + 1 : this.queue.length;
    // Try to look up cached metadata first
    if(data.id in this.library) {
        this.queue.splice(idx, 0, this.library[data.id]);
        this.sendAll("queue", {
            media: this.library[data.id].pack(),
            pos: idx
        });
        this.logger.log("*** Queued from cache: id=" + data.id);
    }
    // Query metadata from YouTube
    else if(data.type == "yt") {
        var callback = (function(chan, id) { return function(res, data) {
            if(res != 200) {
                return;
            }

            try {
                // Whoever decided on this variable name should be fired
                var seconds = data.entry.media$group.yt$duration.seconds;
                // This one"s slightly better
                var title = data.entry.title.$t;
                var vid = new Media(id, title, seconds, "yt");
                chan.queue.splice(idx, 0, vid);
                chan.sendAll("queue", {
                    media: vid.pack(),
                    pos: idx
                });
                chan.addToLibrary(vid);
                chan.logger.log("*** Queued new YT video: " + id);
            }
            catch(e) {
                Logger.errlog.log("YTQueue Fail: id=" + id);
                console.log(e);
            }
        }})(this, data.id);
        InfoGetter.getYTInfo(data.id, callback);
    }
    // YouTube Playlist
    else if(data.type == "yp") {
        var callback = (function(chan, plid) { return function(res, data) {
            if(res != 200) {
                return;
            }

            try {
                for(var i = 0; i < data.feed.entry.length; i++) {
                    var item = data.feed.entry[i];
                    var title = item.title.$t;
                    var url = item.link[1].href;
                    var parts = url.split("/");
                    // INCOMING H4X BECAUSE YTAPI IS INCONSISTENT
                    var last = parts[parts.length - 1];
                    var match = last.match(/watch\?v=([^&]+)/);
                    var id;
                    if(match) {
                        id = match[1];
                    }
                    else {
                        id = parts[parts.length - 2];
                    }
                    var seconds = item.media$group.yt$duration.seconds;
                    var vid = new Media(id, title, seconds, "yt");
                    chan.queue.splice(idx, 0, vid);
                    chan.sendAll("queue", {
                        media: vid.pack(),
                        pos: idx
                    });
                    chan.addToLibrary(vid);
                    idx++;
                }
                chan.logger.log("*** Queued YT Playlist: id=" + plid);
            }
            catch(e) {
                Logger.errlog.log("YTPlaylist Failed: id=", id);
                console.log(e);
            }
        }})(this, data.id);
        InfoGetter.getYTPlaylist(data.id, callback);
    }
    // Set up twitch metadata
    else if(data.type == "tw") {
        var media = new Media(data.id, "Twitch ~ " + data.id, 0, "tw");
        this.queue.splice(idx, 0, media);
        this.sendAll("queue", {
            media: media.pack(),
            pos: idx
        });
        this.logger.log("*** Queued Twitch channel: " + data.id);
    }
    else if(data.type == "li") {
        var media = new Media(data.id, "Livestream ~ " + data.id, 0, "li");
        this.queue.splice(idx, 0, media);
        this.sendAll("queue", {
            media: media.pack(),
            pos: idx
        });
        this.logger.log("*** Queued Livestream channel: " + data.id);
    }
    // Query metadata from Soundcloud
    else if(data.type == "sc") {
        var callback = (function(chan, id) { return function(res, data) {
            if(res != 200) {
                return;
            }

            try {
                var seconds = data.duration / 1000;
                var title = data.title;
                var vid = new Media(id, title, seconds, "sc");
                chan.queue.splice(idx, 0, vid);
                chan.sendAll("queue", {
                    media: vid.pack(),
                    pos: idx
                });
                chan.addToLibrary(vid);
                chan.logger.log("*** Queued Soundcloud id=" + id);
            }
            catch(e) {
                Logger.errlog.log("SCQueue fail: id=" + id);
                Logger.errlog.log(e);
            }
        }})(this, data.id);
        InfoGetter.getSCInfo(data.id, callback);
    }
    // Query metadata from Vimeo
    else if(data.type == "vi") {
        var callback = (function(chan, id) { return function(res, data) {
            if(res != 200) {
                return;
            }

            try {
                data = data[0];
                var seconds = data.duration;
                var title = data.title;
                var vid = new Media(id, title, seconds, "vi");
                chan.queue.splice(idx, 0, vid);
                chan.sendAll("queue", {
                    media: vid.pack(),
                    pos: idx
                });
                chan.addToLibrary(vid);
                chan.logger.log("*** Queued Vimeo id=" + id);
            }
            catch(e) {
                Logger.errlog.log("VIQueue fail: id=" + id);
                Logger.errlog.log(e);
            }
        }})(this, data.id);
        InfoGetter.getVIInfo(data.id, callback);
    }

    // Dailymotion
    else if(data.type == "dm") {
        var callback = (function(chan, id) { return function(res, data) {
            if(res != 200) {
                return;
            }

            try {
                var seconds = data.duration;
                var title = data.title;
                var vid = new Media(id, title, seconds, "dm");
                chan.queue.splice(idx, 0, vid);
                chan.sendAll("queue", {
                    media: vid.pack(),
                    pos: idx
                });
                chan.addToLibrary(vid);
                chan.logger.log("*** Queued Dailymotion id=" + id);
            }
            catch(e) {
                Logger.errlog.log("DMQueue fail: id=" + id);
                Logger.errlog.log(e);
            }
        }})(this, data.id);
        InfoGetter.getDMInfo(data.id, callback);
    }
}

// Removes a media from the play queue
Channel.prototype.unqueue = function(data) {
    // Stop trying to break my server
    if(data.pos < 0 || data.pos >= this.queue.length)
        return;

    this.queue.splice(data.pos, 1);
    this.sendAll("unqueue", {
        pos: data.pos
    });

    if(data.pos == this.currentPosition) {
        this.currentPosition--;
        this.playNext();
        return;
    }
    if(data.pos < this.currentPosition) {
        this.currentPosition--;
    }
}

// Play the next media in the queue
Channel.prototype.playNext = function() {
    if(this.queue.length == 0)
        return;
    var old = this.currentPosition;
    this.voteskip = false;
    if(this.currentPosition + 1 >= this.queue.length) {
        this.currentPosition = -1;
    }
    this.currentPosition++;
    this.currentMedia = this.queue[this.currentPosition];
    this.currentMedia.currentTime = 0;

    this.sendAll("mediaUpdate", this.currentMedia.packupdate());
    this.sendAll("updatePlaylistIdx", {
        old: old,
        idx: this.currentPosition
    });
    // Enable autolead for non-twitch
    if(this.leader == null && this.currentMedia.type != "tw" && this.currentMedia.type != "li") {
        this.time = new Date().getTime();
        channelVideoUpdate(this, this.currentMedia.id);
    }
}

Channel.prototype.jumpTo = function(pos) {
    if(this.queue.length == 0)
        return;
    if(pos >= this.queue.length || pos < 0)
        return;
    this.voteskip = false;
    var old = this.currentPosition;
    this.currentPosition = pos;
    this.currentMedia = this.queue[this.currentPosition];
    this.currentMedia.currentTime = 0;

    this.sendAll("mediaUpdate", this.currentMedia.packupdate());
    this.sendAll("updatePlaylistIdx", {
        idx: this.currentPosition,
        old: old
    });
    // Enable autolead for non-twitch
    if(this.leader == null && this.currentMedia.type != "tw" && this.currentMedia.type != "li") {
        this.time = new Date().getTime();
        channelVideoUpdate(this, this.currentMedia.id);
    }
}

Channel.prototype.setLock = function(locked) {
    this.qlocked = locked;
    this.sendAll("queueLock", {locked: locked});
    for(var i = 0; i < this.users.length; i++) {
        this.sendPlaylist(this.users[i]);
    }
}

// Synchronize to a sync packet from the leader
Channel.prototype.update = function(data) {
    if(this.currentMedia == null) {
        this.currentMedia = new Media(data.id, data.title, data.seconds, data.type);
        this.currentMedia.currentTime = data.currentTime;
    }
    else
        this.currentMedia.currentTime = data.seconds;
    this.sendAll("mediaUpdate", this.currentMedia.packupdate());
}

// Move something around in the queue
Channel.prototype.moveMedia = function(data) {
    if(data.src < 0 || data.src >= this.queue.length)
        return;
    if(data.dest < 0 || data.dest > this.queue.length)
        return;

    var media = this.queue[data.src];
    // Took me a while to figure out why the queue was going insane
    // Gotta account for when you've copied it to the destination
    // but not removed the source yet
    var dest = data.dest > data.src ? data.dest + 1 : data.dest;
    var src  = data.dest > data.src ? data.src : data.src + 1;
    this.queue.splice(dest, 0, media);
    this.queue.splice(src, 1);
    this.sendAll("moveVideo", {
        src: data.src,
        dest: data.dest
    });

    if(data.src < this.currentPosition && data.dest >= this.currentPosition) {
        this.currentPosition--;
    }
    else if(data.src > this.currentPosition && data.dest < this.currentPosition) {
        this.currentPosition++
    }
    else if(data.src == this.currentPosition) {
        this.currentPosition = data.dest;
    }
}

Channel.prototype.updateFilter = function(filter) {
    var found = false;
    for(var i = 0; i < this.filters.length; i++) {
        if(this.filters[i][0].source == filter[0].source) {
            found = true;
            this.filters[i][1] = filter[1];
            this.filters[i][2] = filter[2];
        }
    }
    if(!found) {
        this.filters.push(filter);
    }
    this.broadcastChatFilters();
}

Channel.prototype.removeFilter = function(regex) {
    for(var i = 0; i < this.filters.length; i++) {
        if(this.filters[i][0].source == regex) {
            this.filters.splice(i, 1);
            break;
        }
    }
    this.broadcastChatFilters();
}

// Chat message from a user
Channel.prototype.chatMessage = function(user, msg) {
    if(msg.indexOf("/") == 0)
        ChatCommand.handle(this, user, msg);

    else if(msg.indexOf(">") == 0)
        this.sendMessage(user.name, msg, "greentext");

    else
        this.sendMessage(user.name, msg, "");
}

Channel.prototype.filterMessage = function(msg) {
    msg = msg.replace(/(((https?)|(ftp))(:\/\/[0-9a-zA-Z\.]+(:[0-9]+)?[^\s$]+))/g, "<a href=\"$1\" target=\"_blank\">$1</a>");
    // Apply other filters
    for(var i = 0; i < this.filters.length; i++) {
        if(!this.filters[i][2])
            continue;
        var regex = this.filters[i][0];
        var replace = this.filters[i][1];
        msg = msg.replace(regex, replace);
    }
    return msg;
}

Channel.prototype.sendMessage = function(username, msg, msgclass) {
    // I don"t want HTML from strangers
    msg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    msg = this.filterMessage(msg);
    this.sendAll("chatMsg", {
        username: username,
        msg: msg,
        msgclass: msgclass
    });
    this.recentChat.push({
        username: username,
        msg: msg,
        msgclass: msgclass
    });
    if(this.recentChat.length > 15)
        this.recentChat.shift();
    this.logger.log("<" + username + "." + msgclass + "> " + msg);
};

// Promotion!  Actor is the client who initiated the promotion, name is the
// name of the person being promoted
Channel.prototype.promoteUser = function(actor, name) {
    var receiver;
    for(var i = 0; i < this.users.length; i++) {
        if(this.users[i].name == name) {
            receiver = this.users[i];
            break;
        }
    }

    if(receiver) {
        // You can only promote someone if you are 2 ranks or higher above
        // them.  This way you can"t promote them to your rank and end
        // up in a situation where you can"t demote them
        if(actor.rank > receiver.rank + 1) {
            receiver.rank++;
            if(receiver.loggedIn) {
                this.saveRank(receiver);
            }
            this.logger.log("*** " + actor.name + " promoted " + receiver.name + " from " + (receiver.rank - 1) + " to " + receiver.rank);
            this.broadcastRankUpdate(receiver);
        }
    }
}

// You"re fired
Channel.prototype.demoteUser = function(actor, name) {
    var receiver;
    for(var i = 0; i < this.users.length; i++) {
        if(this.users[i].name == name) {
            receiver = this.users[i];
            break;
        }
    }

    if(receiver) {
        // Wouldn"t it be funny if you could demote people who rank higher
        // than you?  No, it wouldn"t.
        if(actor.rank > receiver.rank) {
            receiver.rank--;
            if(receiver.loggedIn) {
                this.saveRank(receiver);
            }
            this.logger.log("*** " + actor.name + " demoted " + receiver.name + " from " + (receiver.rank + 1) + " to " + receiver.rank);
            this.broadcastRankUpdate(receiver);
        }
    }
}

// Manual leader.  This shouldn"t be necessary since the server autoleads,
// but you never know
Channel.prototype.changeLeader = function(name) {
    if(this.leader != null) {
        var old = this.leader;
        this.leader = null;
        this.broadcastRankUpdate(old);
    }
    if(name == "") {
        this.logger.log("*** Resuming autolead");
        if(this.currentMedia != null) {
            this.time = new Date().getTime();
            this.i = 0;
            channelVideoUpdate(this, this.currentMedia.id);
        }
        return;
    }
    for(var i = 0; i < this.users.length; i++) {
        if(this.users[i].name == name) {
            this.logger.log("*** Assigned leader: " + name);
            this.leader = this.users[i];
            this.broadcastRankUpdate(this.leader);
        }
    }
}

// Send the userlist to a client
// Do you know you"re all my very best friends?
Channel.prototype.sendUserlist = function(user) {
    var users = [];
    for(var i = 0; i < this.users.length; i++) {
        // Skip people who haven"t logged in
        if(this.users[i].name != "") {
            users.push({
                name: this.users[i].name,
                rank: this.users[i].rank,
                leader: this.users[i] == this.leader
            });
        }
    }
    user.socket.emit("userlist", users)
}

Channel.prototype.updateUsercount = function() {
    this.sendAll("usercount", {
        count: this.users.length
    });
}

// Send the play queue
Channel.prototype.sendPlaylist = function(user) {
    user.socket.emit("playlist", {
        pl: this.queue
    });
    user.socket.emit("updatePlaylistIdx", {
        idx: this.currentPosition
    });
}

// Send the last 15 messages for context
Channel.prototype.sendRecentChat = function(user) {
    for(var i = 0; i < this.recentChat.length; i++) {
        user.socket.emit("chatMsg", this.recentChat[i]);
    }
}

// Send a sync packet
Channel.prototype.sendMediaUpdate = function(user) {
    if(this.currentMedia != null) {
        user.socket.emit("mediaUpdate", this.currentMedia.packupdate());
    }
}

// Sent when someone logs in, to add them to the user list
Channel.prototype.broadcastNewUser = function(user) {
    this.sendAll("addUser", {
        name: user.name,
        rank: user.rank,
        leader: this.leader == user
    });
    this.handleRankChange(user);
}

Channel.prototype.handleRankChange = function(user) {
    user.socket.emit("rank", {
        rank: user.rank
    });
    if(Rank.hasPermission(user, "ipban")) {
        var ents = [];
        for(var ip in this.ipbans) {
            if(this.ipbans[ip] != null) {
                ents.push({
                    ip: ip,
                    name: this.ipbans[ip][0],
                    banner: this.ipbans[ip][1]
                });
            }
        }
        user.socket.emit("banlist", {entries: ents});
    }
    if(Rank.hasPermission(user, "chatFilter")) {
        var filts = new Array(this.filters.length);
        for(var i = 0; i < this.filters.length; i++) {
            filts[i] = [this.filters[i][0].source, this.filters[i][1], this.filters[i][2]];
        }
        user.socket.emit("chatFilters", {filters: filts});
    }
}

// Someone"s rank changed, or their leadership status changed
Channel.prototype.broadcastRankUpdate = function(user) {
    this.sendAll("updateUser", {
        name: user.name,
        rank: user.rank,
        leader: this.leader == user
    });
    this.handleRankChange(user);
}

Channel.prototype.broadcastPoll = function() {
    this.sendAll("newPoll", this.poll.packUpdate());
}

Channel.prototype.broadcastPollUpdate = function() {
    this.sendAll("updatePoll", this.poll.packUpdate());
}

Channel.prototype.broadcastPollClose = function() {
    this.sendAll("closePoll");
}

Channel.prototype.broadcastOpts = function() {
    this.sendAll("channelOpts", this.opts);
}

Channel.prototype.broadcastIpbans = function() {
    var ents = [];
    for(var ip in this.ipbans) {
        if(this.ipbans[ip] != null) {
            ents.push({
                ip: ip,
                name: this.ipbans[ip][0],
                banner: this.ipbans[ip][1]
            });
        }
    }
    for(var i = 0; i < this.users.length; i++) {
        if(Rank.hasPermission(this.users[i], "ipban")) {
            this.users[i].socket.emit("banlist", {entries: ents});
        }
    }
}

Channel.prototype.broadcastChatFilters = function() {
    var filts = new Array(this.filters.length);
    for(var i = 0; i < this.filters.length; i++) {
        filts[i] = [this.filters[i][0].source, this.filters[i][1], this.filters[i][2]];
    }
    for(var i = 0; i < this.users.length; i++) {
        if(Rank.hasPermission(this.users[i], "ipban")) {
            this.users[i].socket.emit("chatFilters", {filters: filts});
        }
    }
}

Channel.prototype.broadcastMotd = function() {
    this.sendAll("updateMotd", this.motd);
}

Channel.prototype.handleVoteskip = function(user) {
    if(!this.voteskip) {
        this.voteskip = new Poll("voteskip", "voteskip", ["yes"]);
    }
    this.voteskip.vote(user.ip, 0);
    if(this.voteskip.counts[0] > this.users.length / 2) {
        this.playNext();
    }
}

// Send to ALL the clients!
Channel.prototype.sendAll = function(message, data) {
    io.sockets.in(this.name).emit(message, data);
}

// Autolead yay
function channelVideoUpdate(chan, id) {
    // Someone changed the video or there"s a manual leader, so your
    // argument is invalid
    if(chan.currentMedia == null || id != chan.currentMedia.id || chan.leader != null)
        return;
    // Add dt since last update
    chan.currentMedia.currentTime += (new Date().getTime() - chan.time)/1000.0;
    chan.time = new Date().getTime();
    // Video over, move on to next
    if(chan.currentMedia.currentTime > chan.currentMedia.seconds) {
        chan.playNext();
    }
    // Every ~5 seconds send a sync packet to everyone
    else if(chan.i % 5 == 0)
        chan.sendAll("mediaUpdate", chan.currentMedia.packupdate());
    chan.i++;
    // Do it all over again in about a second
    setTimeout(function() { channelVideoUpdate(chan, id); }, 1000);
}

exports.Channel = Channel;
