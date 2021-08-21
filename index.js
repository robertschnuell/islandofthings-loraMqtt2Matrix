const mqtt = require('mqtt')
const matrix = require("matrix-js-sdk");
const yaml = require("js-yaml")
const fs = require('fs');

const cors = require('cors');

var devices = JSON.parse(fs.readFileSync('devices.json'));
const config = JSON.parse(fs.readFileSync('config.json'));

const express = require('express');
const bodyParser = require('body-parser');



const bot = {
    "mx_access_token": config.matrix.mx_access_token,
    "mx_user_id": config.matrix.mx_user_id,
    "mx_home_server": config.matrix.mx_home_server,
    "mx_baseurl": config.matrix.mx_baseurl
}


const botClient =   matrix.createClient({
    baseUrl: bot.mx_baseurl,
    accessToken: bot.mx_access_token,
    userId: bot.mx_user_id
});


const mqttOptions={
    clientId:"node",
    username:config.mqtt.user,
    password:config.mqtt.password,
    clean:true
};

const client  = mqtt.connect(config.mqtt.broker,mqttOptions)
//const client  = mqtt.connect(config.mqtt.broker)






console.log(config.mqtt.broker)
client.on('connect', function () {
  client.subscribe('newmedia/#', function (err) {
    if (!err) {
      console.log("connected to MQTT")
    } else {
        console.log(err)
    }
  })
})
 
client.on('message', function (topic, message) {
  // message is Buffer
  let topicSplit = topic.split("/");



  const device = (devices.find( (device) => device.DEV_ADD === topicSplit[1]))
  if(device != null ) {
    parse(device,message.toString());
  }
})



function parse(device,data) {

    /* 
    hex string should be seperated into 4 pieces
    example:
        ffffffd00000005f616263313200
        ffffffd1    00000061    61 62 63 31 32 			00
        RSSI        SNR         PAYLOAD                 CHECKSUM

    RSSI and SNR are each fixed 4 bytes. The checksum is fixed 1 byte. The length of the payload can vary.
    be aware that the RSSI and SNR should be parsed into signed! integers, 
    otherwise you will get onlx positive numbers, which are in this case totally wrong
    */

    if (data == null || data.length <= 0) {
        return;
    }
    const rssi = hexToInt(data.substring(0,8));
    const snr = hexToInt(data.substring(8,16));
    const payload = ((data.substring(16,data.length-2)).match(/.{1,2}/g)).map((i) => ("0x" + i));
    // isolate the payload out of the complete data string and split it via regEx into 1 byte pieces (each 2 hex 'chars') and adding 0x as hex indicator

  
    console.log(payload)

    let match = false;


    device.payloads.forEach( (type) => {
        switch (type.type) {
            case "ascii":
                let msg = payload.slice(type.startByte,type.startByte+type.len);
                sendToMatrix(type.roomId,String.fromCharCode.apply(null, msg),device.active);
                match = true;
                break;
            case "boolean": 
                if(payload[type.startByte] === "0xFF") {
                    match = true;
                    sendToMatrix(type.roomId,"true",device.active);
                } else if (payload[type.startByte] === "0x00"){
                    match = true;
                    sendToMatrix(type.roomId,"false",device.active);
                }
                break;
            case "value":
                match = true;
                let val = "0x"+(payload.slice(type.startByte,type.startByte+type.len).join('')).replace(/(0x)/g,"");
                sendToMatrix(type.roomId,hexToInt(val).toString(),device.active);
                break;
            default:
                return;
        }
    });

    if(match && device.logLevel === "high") {
        sendToMatrix(device.debugRoom,"rssi:" + rssi + "\nsnr:" + snr,device.active);
    }

}

async function check4Matrix(device,roomId) {
    let client;
    
    if(device.hasOwnProperty("mx_access_token")) {
       client = matrix.createClient({
            baseUrl: device.mx_baseurl,
            accessToken: device.mx_access_token,
            userId: device.mx_user_id
        });

        client.getJoinedRooms().then ((result) => {
            console.log(result.joined_rooms.length)
            if(result.joined_rooms.includes(roomId)) {
                return true;
            } else {
                return false;
            }
        })
    }

    return 

}


function sendToMatrix(roomId,message,send = false,accesstoken ) {

    if(roomId == null || message == null || send == false) {
        return
    }
    if(accesstoken != null && accesstoken.length > 0) {
        
    } else {
        //no own auth so use bot
        let content = {
            "body": message,
            "msgtype": "m.text"
        };

        botClient.sendEvent(roomId, "m.room.message", content, "").then((res) => {
            console.log(res);
        }).catch((err) => {
            console.log(err);
        })
    }
}


function hexToInt(hex) {
    if (hex.length % 2 != 0) {
        hex = "0" + hex;
    }
    var num = parseInt(hex, 16);
    var maxVal = Math.pow(2, hex.length / 2 * 8);
    if (num > maxVal / 2 - 1) {
        num = num - maxVal
    }
    return num;
}






// API Webserver
const port = 3000
var app = express()
app.use(express.json({
    verify : (req, res, buf, encoding) => {
      try {
        JSON.parse(buf);
      } catch(e) {
        res.status(404).send({"status":"invalid json"});
        throw Error('invalid JSON');
      }
    }
  }),
  cors({
    origin: '*'
  })
);
app.listen(port)



app.post('/devices/add',verifyToken, (req, res) =>  {
    if(validToken(req.token)) {
        devices.push(req.body);
        fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
        res.sendStatus(201);
    } else {
        res.status(403).json({"error":"invalid token"})
    }
})

  app.get('/devices',verifyToken,  (req, res) => {
    console.log(req.token)
    if(validToken(req.token)) {
        res.status(200).json(devices)
    } else {
        res.status(403).json({"error":"invalid token"})
    }
  })

  app.patch('/devices/:deviceId/activate',verifyToken,  (req, res) => {
    console.log(req.token)
    if(validToken(req.token)) {
        const deviceNo = (devices.findIndex( (device) => device.DEV_ADD === req.params.deviceId.toString()))
        if(deviceNo != null && deviceNo >= 0) {
            //patch device 
            devices[deviceNo].active = true;
            fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
            res.status(200).json({"status":"updated"});
        } else {
            res.status(404).json({"status":"device not found"})
        }
    } else {
        res.status(403).json({"error":"invalid token"})
    }
  })

  app.patch('/devices/:deviceId/deactivate',verifyToken,  (req, res) => {
    console.log(req.token)
    if(validToken(req.token)) {
        const deviceNo = (devices.findIndex( (device) => device.DEV_ADD === req.params.deviceId.toString()))
        if(deviceNo != null && deviceNo >= 0) {
            //patch device 
            devices[deviceNo].active = false;
            fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
            res.status(200).json({"status":"updated"});
        } else {
            res.status(404).json({"status":"device not found"})
        }
    } else {
        res.status(403).json({"error":"invalid token"})
    }
  })

  app.patch('/devices/:deviceId',verifyToken,  (req, res) => {
    console.log(req.token)
    if(validToken(req.token)) {
        const deviceNo = (devices.findIndex( (device) => device.DEV_ADD === req.params.deviceId.toString()))
        if(deviceNo != null && deviceNo >= 0) {
            if ( ( 'DEV_ADD' in req.body) && ( 'name' in req.body) && ( 'matrixSpace' in req.body)  && ( 'active' in req.body)) {
                console.log("exists")
                devices[deviceNo] = req.body
                fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
                res.status(200).json({"status":"updated"});
            } else {
                res.status(200).json({"status":"not valid structure"});
            }
        } else {
            res.status(404).json({"status":"device not found"})
        }
    } else {
        res.status(403).json({"error":"invalid token"})
    }
  })

  app.delete('/devices/:deviceId/delete',verifyToken,  (req, res) => {
    console.log(req.token)
    if(validToken(req.token)) {
        const deviceNo = (devices.findIndex( (device) => device.DEV_ADD === req.params.deviceId.toString()))
        if(deviceNo != null && deviceNo >= 0) {
            //patch device 
            devices.splice(deviceNo, 1);
            fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
            res.status(200).json({"status":deviceNo});
        } else {
            res.status(404).json({"status":"device not found"})
        }
    } else {
        res.status(403).json({"error":"invalid token"})
    }
  })

  app.patch('/devices',verifyToken,  (req, res) => {
    if(validToken(req.token)) {
        devices = req.body
        fs.writeFileSync('devices.json', JSON.stringify(devices, null, 2));
        res.status(200).json(devices)
    } else {
        res.status(403).json({"error":"invalid token"})
    }
    
  })

  function validToken(token) {
      return token == config.matrix.mx_access_token
  }


  function verifyToken(req, res, next) {
    const bearerHeader = req.headers['authorization'];
    if (bearerHeader) {
      const bearer = bearerHeader.split(' ');
      const bearerToken = bearer[1];
      req.token = bearerToken;
      next();
    } else {
      // Forbidden
      res.status(403).json({"error":"Token missing"})
    }
  }