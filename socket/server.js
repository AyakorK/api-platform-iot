var SerialPort = require('serialport');
var xbee_api = require('xbee-api');
var mqtt = require('mqtt');
var C = xbee_api.constants;
require('dotenv').config();

const SERIAL_PORT = process.env.SERIAL_PORT;
let players = {};
let buttonsActivated = {};
let playerTurn = null;


var xbeeAPI = new xbee_api.XBeeAPI({
  api_mode: 1
});

let serialport = new SerialPort(SERIAL_PORT, {
  baudRate: parseInt(process.env.SERIAL_BAUDRATE) || 9600,
}, function (err) {
  if (err) {
    return console.log('Error: ', err.message);
  }
});

serialport.pipe(xbeeAPI.parser);
xbeeAPI.builder.pipe(serialport);

// Create an MQTT client
const mqttClient = mqtt.connect(process.env.MQTT_URL);

// Handle MQTT connection
mqttClient.on('connect', function () {
  console.log('Connected to MQTT broker');

  // Subscribe to the MQTT topic
  const mqttTopic = 'battleships/sensor/triggered';  // Replace with your MQTT topic
  mqttClient.subscribe(mqttTopic, function (err) {
    if (err) {
      console.error('Error subscribing to MQTT topic:', err);
    } else {
      console.log('Subscribed to MQTT topic:', mqttTopic);
    }
  });
});

mqttClient.on('connect', function () {
  console.log('Connected to MQTT broker');

  // Subscribe to the MQTT topic
  const mqttTopic = 'battleships/start/game';  // Replace with your MQTT topic
  mqttClient.subscribe(mqttTopic, function (err) {
    if (err) {
      console.error('Error subscribing to MQTT topic:', err);
    } else {
      console.log('Subscribed to MQTT topic:', mqttTopic);
    }
  });
});

// Handle incoming MQTT messages
mqttClient.on('message', function (topic, message) {
  console.log('Received message from topic:', topic);
  console.log('Message:', message.toString());

  if (topic === 'battleships/start/game') {
    resetGame(players);
  }
});

serialport.on("open", function () {
  var frame_obj = { // AT Request to be sent
    type: C.FRAME_TYPE.AT_COMMAND,
    command: "NI",
    commandParameter: [],
  };

  xbeeAPI.builder.write(frame_obj);

  frame_obj = { // AT Request to be sent
    type: C.FRAME_TYPE.REMOTE_AT_COMMAND_REQUEST,
    destination64: "FFFFFFFFFFFFFFFF",
    command: "NI",
    commandParameter: [],
  };
  xbeeAPI.builder.write(frame_obj);
});

xbeeAPI.parser.on("data", function (frame) {


  if (C.FRAME_TYPE.REMOTE_COMMAND_RESPONSE === frame.type) {
    console.log("REMOTE_COMMAND_RESPONSE")
    players[String.fromCharCode.apply(null, frame.commandData)] = frame.remote64;

    if (Object.keys(players).length > 1) {
      // console.log("Players: ", players);
      // Send MQTT message
      const mqttTopic = 'battleships/players';  // Replace with your MQTT topic
      mqttClient.publish(mqttTopic, JSON.stringify(players));
    } else {
      const mqttTopic = 'battleships/waiting_players';  // Replace with your MQTT topic
      mqttClient.publish(mqttTopic, JSON.stringify(players));
    }

  } else if (C.FRAME_TYPE.ZIGBEE_RECEIVE_PACKET === frame.type) {

    if (Object.keys(players).length < 2) {
      const mqttTopic = 'battleships/waiting_players';  // Replace with your MQTT topic
      mqttClient.publish(mqttTopic, "Currently not enough players to start the game");
      return
    }

    // if (playerTurn !== frame.remote64) {
    //   return
    // }
    // console.log("C.FRAME_TYPE.ZIGBEE_RECEIVE_PACKET");
    // console.log(frame)
    let dataReceived = String.fromCharCode.apply(null, frame.data);
    // console.log(dataReceived)
    let data = dataReceived.split("\r\n");

    // Now create a dictionnary : ex: sensor 3 : 9 becomes "sensor3":9
    let dictionnary = {};
    // Identify the dictionnary by the player
    dictionnary["player"] = frame.remote64;
    for (let i = 0; i < data.length; i++) {
      let line = data[i].trim().split(":");
      // Get rid of every spaces
      if (line.length === 2) {
        dictionnary[line[0].trim()] = line[1].trim();
      }
    }
    // console.log(dictionnary);
    // console.log("-----------------")

    // console.log("PLAYERS: ", players);
    checkSensors(dictionnary, frame);
    checkButtons(dictionnary, frame);
  } else {
    // console.log("FRAME_TYPE:", frame.type)
  }
});

function checkSensors(dictionnary, request) {
  // If any sensor is triggered (>250), send a MQTT message
  // Take all the keys that contain "sensor"
  let sensors = Object.keys(dictionnary).filter(key => key.includes("ensor"));

  let sensorsActivated = sensors.filter(sensor => dictionnary[sensor] > 250);
  if (sensorsActivated.length === 1) {
    const mqttTopic = 'battleships/sensor/triggered';  // Replace with your MQTT topic
    const playerIdentity = Object.keys(players).find(key => players[key] !== dictionnary["player"]);
    mqttClient.publish(mqttTopic, `Case ${JSON.stringify(sensorsActivated[0])} of ${playerIdentity} has been targeted`);

    const playerToDisable = players[playerIdentity]

    disableLight(playerToDisable, sensorsActivated[0], request)
  } else if (sensorsActivated.length > 1) {
    console.log("Error: ", sensorsActivated.length, " sensors activated");
  }
}

function checkButtons(dictionnary, request) {
  // If any button is pressed, send a MQTT message
  let buttons = Object.keys(dictionnary).filter(key => key.includes("button"));

  let buttonsActivated = buttons.filter(button => dictionnary[button] === "1");

  if (buttonsActivated.length === 1) {
    activateLight(dictionnary["player"], buttonsActivated[0], request);
    changeTurn(dictionnary["player"]);
  } else if (buttonsActivated.length > 2) {
    console.log("Error: ", buttonsActivated.length, " buttons activated");
  }
}

function activateLight(player, button, request) {

  if (request.remote64 !== player) {
    console.log("Wrong player")
    return
  }

  const destination64 = player

  if (buttonsActivated[player] && buttonsActivated[player].length > 1) {
    console.log("Too many buttons activated")
    return
  }

  if (buttonsActivated[player]) {
    if (buttonsActivated[player].includes(button)) {
      console.log("Button already activated")
      return
    }
    buttonsActivated[player].push(button)
  } else {
    buttonsActivated[player] = [button]
  }

  let lightNumber = button.split(" ")[1]
  lightNumber = parseInt(lightNumber) + 1
  const frame_obj = { // AT Request to be sent
    type: 0x10,
    destination64: destination64,
    data: `${lightNumber}:HIGH\n`,
  };
  xbeeAPI.builder.write(frame_obj);

  const mqttTopic = 'battleships/button/pressed';  // Replace with your MQTT topic
  // Identify player (player 1 or 2)
  const playerIdentity = Object.keys(players).find(key => players[key] === player);
  mqttClient.publish(mqttTopic, `Button ${JSON.stringify(buttonsActivated[0])} of ${playerIdentity} has been activated`);

  console.log("Buttons activated: ", buttonsActivated)
}

function resetGame(players) {
  let mqttTopic = 'battleships/game/start';  // Replace with your MQTT topic
  mqttClient.publish(mqttTopic, `New game starts`);

  buttonsActivated = {}

  // Reset the lights to LOW for every players
  for (let player in players) {
    const destination64 = players[player]
    for (let i = 0; i < 4; i++) {
      const frame_obj = { // AT Request to be sent
        type: 0x10,
        destination64: destination64,
        data: `${i + 1}:LOW\n`,
      };
      xbeeAPI.builder.write(frame_obj);
    }
  }
  // playerTurn is the a random player
  playerTurn = Object.values(players)[Math.floor(Math.random() * Object.values(players).length)];
  console.log("Player turn: ", playerTurn)

  mqttTopic = 'battleships/game/turn';  // Replace with your MQTT topic
  // Identify player (player 1 or 2)
  const playerIdentity = Object.keys(players).find(key => players[key] === player);
  mqttClient.publish(mqttTopic, `Player ${playerIdentity} turn`);
}

function changeTurn(player) {
  // Player turn is the next element in the array (or the first one if it's the last one)
  const playersArray = Object.values(players)
  const index = playersArray.indexOf(player)
  playerTurn = playersArray[(index + 1) % playersArray.length]
  console.log("Player turn: ", playerTurn)

  const mqttTopic = 'battleships/game/turn';  // Replace with your MQTT topic
  // Identify player (player 1 or 2)
  const playerIdentity = Object.keys(players).find(key => players[key] === player);
  mqttClient.publish(mqttTopic, `Player ${playerIdentity} turn`);
}

function disableLight(player, sensor, request) {


    if (request.remote64 === player) {
      console.log("Wrong player")
      return
    }

    const destination64 = player

    let lightNumber = sensor.split(" ")[1]
    lightNumber = parseInt(lightNumber) + 1
    console.log(lightNumber)
    const frame_obj = { // AT Request to be sent
      type: 0x10,
      destination64: destination64,
      data: `${lightNumber}:LOW\n`,
    };
    xbeeAPI.builder.write(frame_obj);

    // Get the buttons activated by the player
    const buttons = buttonsActivated[player]
    // Chec kfi the sensor split[":"] is in the buttons array
    const button = buttons.find(button => button.split(":")[1] === sensor.split(":")[1])

    if (button) {
      // Remove the button from the array
      buttonsActivated[player] = buttons.filter(button => button.split(":")[1] !== sensor.split(":")[1])

      mqttClient.publish('battleships/sensor/destroyed', `Case ${JSON.stringify(sensor)} of ${player} has been destroyed`);

      checkLose(player)
    } else {
      mqttClient.publish('battleships/sensor/missed', `Case ${JSON.stringify(sensor)} of ${player} was empty`);
    }

    changeTurn(request.remote64)
}

function checkLose(player) {
  if (buttonsActivated[player].length === 0) {
    mqttClient.publish('battleships/player/lose', `Player ${player} has lost`);
  }

  checkWin()
}

function checkWin() {
  // For each player, check if all the buttons of every player except one are destroyed
  const playersArray = Object.values(players)
  for (let i = 0; i < playersArray.length; i++) {
    const player = playersArray[i]
    const buttons = buttonsActivated[player]
    if (buttons.length === 0) {
      // Player has lost
      playersArray.splice(i, 1)
      i--
    }
  }

  if (playersArray.length === 1) {
    mqttClient.publish('battleships/player/win', `Player ${playersArray[0]} has won`);
  }
}

// Handle errors
mqttClient.on('error', function (error) {
  console.error('MQTT error:', error);
});
