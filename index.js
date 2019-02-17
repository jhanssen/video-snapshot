const options = require("@jhanssen/options")("video-snapshot");
const ffmpeg = require("fluent-ffmpeg");
const tmp = require("tmp");
const sharp = require("sharp");
const mqtt = require("mqtt");
const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");

const tmpName = promisify(tmp.tmpName);
const read = promisify(fs.readFile);

const dir = options("dir");
if (!dir) {
    console.error("no dir to watch");
    process.exit(1);
}

const mqtthost = options("mqtt-host");
const mqttport = options.int("mqtt-port", 1883);

if (!mqtthost || !mqttport) {
    console.error("no mqtt config");
    process.exit(1);
}

const width = options.int("resize-width", 320);
const height = options.int("resize-height", 200);
if (!width || !height) {
    console.error("invalid width/height");
    process.exit(1);
}

const ffprobePath = options("ffprobe-path");
if (ffprobePath) {
    ffmpeg.setFfprobePath(ffprobePath);
}
const ffmpegPath = options("ffmpeg-path");
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}
const flvtoolPath = options("flvtool-path");
if (flvtoolPath) {
    ffmpeg.setFlvtoolPath(flvtoolPath);
}

const mqttuser = options("mqtt-user");
const mqttpasswd = options("mqtt-password");

function append(str, sub) {
    if (str.substr(sub.length * -1) === sub)
        return str;
    return str + sub;
}

const mqtttopic = append(options("mqtt-topic", "/security/camera/"), "/");
const subtopic = "motion";

const interval = options.int("publish-interval", 10000);

const namerx = /my region in ([^ $]+)/;

const watcher = chokidar.watch(dir, { 
    ignoreInitial: true, 
    persistent: true,
    ignored: /(^|[\/\\])\../
});
watcher.on("add", file => {
    console.log("file added", file);
    const match = namerx.exec(file);
    if (!match) {
        console.error("add file name mismatch", file);
        return;
    }
    const region = match[1].toLowerCase();
    tmpName().then(tname => {
        const parsed = path.parse(path.resolve(tname + ".png"));
        if (!parsed || !parsed.dir || !parsed.base) {
            console.error("failed to parse path", parsed, path.resolve(tname + path.extname(file)));
            process.exit(1);
        }
        ffmpeg(file).on("end", () => {
            const pngname = path.join(parsed.dir, parsed.base);
            console.log("wrote", pngname);
            read(pngname, null).then(pngbuf => {
                fs.unlinkSync(pngname);

                console.log(`resizing to ${width}x${height}`);
                sharp(pngbuf)
                    .resize(width, height)
                    .toFormat("jpeg")
                    .toBuffer()
                    .then(resized => {
                        const topic = append(mqtttopic + region, "/") + subtopic;
                        console.log("publishing to", topic);
                        mqttclient.publish(topic, resized);
                    }).catch(err => {
                        console.error("failed to resize", err);
                    });
            }).catch(err => {
                fs.unlinkSync(pngname);
                console.error("failed to read png", pngname, err);
                process.exit(1);
            });
            //process.exit(0);
        }).on("error", err => {
            console.error("ffmpeg error", err);
            process.exit(1);
        }).screenshots({
            folder: parsed.dir,
            filename: parsed.base,
            timestamps: ["50%"]
        });
    }).catch(err => {
        console.error("failed to make tmpname", err);
        process.exit(1);
    });
});

let mqttauth = "";
if (mqttuser || mqttpasswd) {
    if (!mqttuser || !mqttpasswd) {
        console.error("needs both mqtt user and password if one is set");
        process.exit(1);
    }
    mqttauth = `${mqttuser}:${mqttpasswd}@`;
}

const mqttclient = mqtt.connect(`mqtt://${mqttauth}${mqtthost}:${mqttport}`);
mqttclient.on("error", err => {
    console.error("mqtt error", err);
});
