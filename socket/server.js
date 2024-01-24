var SerialPort = require('serialport');
var xbee_api = require('xbee-api');
var mqtt = require('mqtt');
var C = xbee_api.constants;
require('dotenv').config();

const SERIAL_PORT = process.env.SERIAL_PORT;
let isLightOn = false;
let isColorOne = false;

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
  const mqttTopic = 'battleships/button/release';  // Replace with your MQTT topic
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

  const destination64 = "FFFFFFFFFFFFFFFF";

  frame_obj = { // AT Request to be sent
    type: C.FRAME_TYPE.AT_COMMAND,
    destination64: destination64,
    command: "D0",
    commandParameter: [4],
  };
  xbeeAPI.builder.write(frame_obj);
});

// All frames parsed by the XBee will be emitted here
xbeeAPI.parser.on("data", function (frame) {

  //on new device is joined, register it

  //on packet received, dispatch event
  //let dataReceived = String.fromCharCode.apply(null, frame.data);
  if (C.FRAME_TYPE.ZIGBEE_RECEIVE_PACKET === frame.type) {
    console.log("C.FRAME_TYPE.ZIGBEE_RECEIVE_PACKET");
    let dataReceived = String.fromCharCode.apply(null, frame.data);
    console.log(">> ZIGBEE_RECEIVE_PACKET >", dataReceived);

  }

  if (C.FRAME_TYPE.NODE_IDENTIFICATION === frame.type) {
    // let dataReceived = String.fromCharCode.apply(null, frame.nodeIdentifier);
    console.log("NODE_IDENTIFICATION");
    //storage.registerSensor(frame.remote64)

  } else if (C.FRAME_TYPE.ZIGBEE_IO_DATA_SAMPLE_RX === frame.type) {

    console.log("ZIGBEE_IO_DATA_SAMPLE_RX")
    console.log(frame.digitalSamples.DIO2)
    //storage.registerSample(frame.remote64,frame.analogSamples.AD0 )

    // Define a variable to track the state of the light

    console.log(frame)
// Check if the button is pressed
    if (frame.digitalSamples.DIO2 === 0) {
      console.log("Button pressed");

      // Toggle the state of the light
      isLightOn = !isLightOn;

      // Define the command parameter based on the light state
      const commandParameter = isLightOn ? [4] : [5];
      let commandToPress = isColorOne ? "D5" : "D0";
      console.log(commandToPress)
      if (isLightOn) {
      } else {
        isColorOne = !isColorOne;
      }

      // AT Request to be sent for D0
      const frameObjD0 = {
        type: C.FRAME_TYPE.AT_COMMAND,
        destination64: frame.remote64,
        command: "D0",
        commandParameter,
      };
      xbeeAPI.builder.write(frameObjD0);

      // AT Request to be sent for D1
      const frameObjD1 = {
        type: C.FRAME_TYPE.REMOTE_AT_COMMAND_REQUEST,
        destination64: process.env.DISTANT_ZIGBEE,
        command: commandToPress,
        commandParameter,
      };
      xbeeAPI.builder.write(frameObjD1);

      const mqttTopic = 'battleships/button/press';  // Replace with your MQTT topic
      const mqttPayload = JSON.stringify({
        buttonPressed: true,
        isLightOn: isLightOn,
        isColorOne: isColorOne,
      });

      mqttClient.publish(mqttTopic, mqttPayload);
    } else {
      console.log("Button released");
      const mqttTopic = 'battleships/button/release';  // Replace with your MQTT topic
      const mqttPayload = JSON.stringify({
        buttonReleased: true,
      });

      console.log(mqttPayload)

      mqttClient.publish(mqttTopic, mqttPayload);

      console.log("MQTT Published")
    }


  } else if (C.FRAME_TYPE.REMOTE_COMMAND_RESPONSE === frame.type) {
    console.log("REMOTE_COMMAND_RESPONSE")
  } else {
    console.debug(frame);
    let dataReceived = String.fromCharCode.apply(null, frame.commandData)
    console.log(dataReceived);
  }
});

// Handle errors
mqttClient.on('error', function (error) {
  console.error('MQTT error:', error);
});
