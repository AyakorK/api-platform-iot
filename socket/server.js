var SerialPort = require('serialport');
var xbee_api = require('xbee-api');
var mqtt = require('mqtt');
var C = xbee_api.constants;
require('dotenv').config();

const SERIAL_PORT = process.env.SERIAL_PORT;
let players = {};
let buttonsActivated = {};
let playerTurn = null;
let canPlay = false;


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
    if (frame.remote64 === process.env.DISTANT_ZIGBEE_ILAN) {
      players["Ilan"] = frame.remote64;
    } else if (frame.remote64 === process.env.DISTANT_ZIGBEE_LUCAS) {
      players["Lucas"] = frame.remote64;
    } else {
      players[String.fromCharCode.apply(null, frame.commandData)] = frame.remote64;
    }

    if (Object.keys(players).length > 1) {
      // console.log("Players: ", players);
      // Send MQTT message
      const mqttTopic = 'battleships/players';  // Replace with your MQTT topic
      // Create a dictionnary with the players to send : "Player 1": "0013A20040B3C7C1"
      const dictToSend = {};
      let i = 1;
      Object.keys(players).forEach(key => {
        dictToSend[`Player ${i}`] = players[key];
        i++;
      });
      mqttClient.publish(mqttTopic, JSON.stringify(dictToSend));
    } else {
      const mqttTopic = 'battleships/waiting_players';  // Replace with your MQTT topic
      mqttClient.publish(mqttTopic, "Currently not enough players to start the game");
    }
  } else if (C.FRAME_TYPE.ZIGBEE_RECEIVE_PACKET === frame.type) {

    if (Object.keys(players).length < 2) {
      const mqttTopic = 'battleships/waiting_players';  // Replace with your MQTT topic
      mqttClient.publish(mqttTopic, "Currently not enough players to start the game");
      return
    }

    if (playerTurn === null) {
      resetGame(players);
    }

    if (playerTurn !== frame.remote64) {
      return
    }

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

    if (!checkEnoughLights()) {
      console.log("Not enough lights")
      return
    }

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
    const mqttTopic = 'battleships/player/wrong';  // Replace with your MQTT topic
    mqttClient.publish(mqttTopic, `It's not your turn ${player}`);
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
  mqttClient.publish(mqttTopic, `${playerIdentity} has activated a light`);

  console.log("Buttons activated: ", buttonsActivated)
}

function resetGame(players) {
  let mqttTopic = 'battleships/game/start';  // Replace with your MQTT topic
  mqttClient.publish(mqttTopic, `New game starts`);

  if (Object.keys(players).length > 1) {
    // console.log("Players: ", players);
    // Send MQTT message
    const mqttTopic = 'battleships/players';  // Replace with your MQTT topic
    // Create a dictionnary with the players to send : "Player 1": "0013A20040B3C7C1"
    const dictToSend = {};
    let i = 1;
    Object.keys(players).forEach(key => {
      dictToSend[`Player ${i}`] = key;
      i++;
    });
    mqttClient.publish(mqttTopic, JSON.stringify(dictToSend));
  } else {
    const mqttTopic = 'battleships/waiting_players';  // Replace with your MQTT topic
    mqttClient.publish(mqttTopic, "Currently not enough players to start the game");
  }

  buttonsActivated = {}

  // Reset the lights to LOW for every players
  for (let player in players) {
    const destination64 = players[player]
    for (let i = 1; i < 5; i++) {
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
  const playerIdentity = Object.keys(players).find(key => players[key] === playerTurn);
  mqttClient.publish(mqttTopic, `${playerIdentity}'s turn`);
}

function changeTurn(player) {
  // Player turn is the next element in the array (or the first one if it's the last one)
  const playersArray = Object.values(players)
  const index = playersArray.indexOf(player)
  playerTurn = playersArray[(index + 1) % playersArray.length]
  console.log("Player turn: ", playerTurn)

  const mqttTopic = 'battleships/game/turn';  // Replace with your MQTT topic
  // Identify player (player 1 or 2)
  const nextPlayerIdentity = Object.keys(players).find(key => players[key] !== player);
  mqttClient.publish(mqttTopic, `${nextPlayerIdentity}'s turn`);
}

function disableLight(player, sensor, request) {
  console.log("Disable light: ", player, sensor)

  if (!checkEnoughLights()) {
    console.log("Not enough lights")
    return
  }


  if (request.remote64 === player) {
    console.log("Wrong player")
    const mqttTopic = 'battleships/player/wrong';  // Replace with your MQTT topic
    mqttClient.publish(mqttTopic, `It's not your turn ${request.remote64}`);
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

    console.log("Buttons Selected 1: ", buttons)


    if (!buttons) {
      console.log("No buttons activated")
      return
    }

    const button = buttons.find(button => button.split(" ")[1] === sensor.split(" ")[1])

    if (button !== undefined) {
      // Remove the button from the array
      buttonsActivated[player] = buttons.filter(button => button.split(" ")[1] !== sensor.split(" ")[1])

      const playerIdentity = Object.keys(players).find(key => players[key] === player);

      const sensorNumber = sensor.split(" ")[1]

      console.log("Buttons Selected 3: ", buttonsActivated[player])

      const otherPlayerIdentity = Object.keys(players).find(key => players[key] !== player);

      const sentences = [`The ship of ${playerIdentity} is drowning !`, `Good shot ${otherPlayerIdentity} you just nailed it !`, `${otherPlayerIdentity} touched ${playerIdentity}`, `What a shot from ${otherPlayerIdentity} !`, `You just destroyed ${playerIdentity}`]
      const sentence = sentences[Math.floor(Math.random() * sentences.length)];
      mqttClient.publish('battleships/sensor/destroyed', sentence);

      checkLose(player)
    } else {

      console.log ("Missed")

      const sensorNumber = sensor.split(" ")[1]

      const playerIdentity = Object.keys(players).find(key => players[key] === player);

      const otherPlayerIdentity = Object.keys(players).find(key => players[key] !== player);

      const sentences = [`Case ${sensorNumber} of ${playerIdentity} was empty`, `You need to aim a ship ${otherPlayerIdentity} not the water`, `${otherPlayerIdentity} missed ${playerIdentity}`, `Damn it ${otherPlayerIdentity} you missed ${playerIdentity}`, `That was such a bad shot ${otherPlayerIdentity}`]
      const sentence = sentences[Math.floor(Math.random() * sentences.length)];
      mqttClient.publish('battleships/sensor/missed', sentence);
    }

    changeTurn(request.remote64)
}

function checkLose(player) {
  console.log(buttonsActivated)

  if (buttonsActivated && buttonsActivated[player].length === 0) {
    mqttClient.publish('battleships/player/elimination', `Player ${player} has lost`);
  }

  checkWin()
}

function checkWin() {
  const playersArray = Object.values(players)

  for (let i = 0; i < playersArray.length; i++) {
    const player = playersArray[i]
    const buttons = buttonsActivated[player]
    if (buttons === undefined || buttons.length === 0) {
      // Player has lost
      playersArray.splice(i, 1)
      i--
    }
  }

  if (playersArray.length === 1) {
    console.log("Player won: ", playersArray[0])
    mqttClient.publish('battleships/player/win', `Player ${playersArray[0]} has won`);
  } else if (playersArray.length === 0) {
    console.log("No player has won")
    mqttClient.publish('battleships/player/win', `No player has won`);
  } else {
    // Continue the game
    console.log("Continue the game")
  }
}

function checkEnoughLights() {
  // For all the players look in buttonsActivated that there is at least two buttons activated
  if (!canPlay) {
    for (let player in players) {
      const buttons = buttonsActivated[player]
      console.log(buttonsActivated[player])
      if (buttons === undefined || buttons.length < 2) {
        console.log("Not enough lights activated")
        const mqttTopic = 'battleships/game/not_enough_lights';  // Replace with your MQTT topic
        console.log(`Not enough lights activated for ${player}`)
        mqttClient.publish(mqttTopic, `Not enough lights activated for ${player}`);
        return false
      } else {
        canPlay = true
      }
    }
  }

  return true
}

// Handle errors
mqttClient.on('error', function (error) {
  console.error('MQTT error:', error);
});
