'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");
const axios = require('axios');
const {performance} = require('perf_hooks');
const CONFIG = require('./config.js');


class UnidentifiedSensorError extends Error {
	constructor(message) {
		super(message);
		this.name = 'UnidentifiedSensorError';
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getRequestBody(adr) {
	return `{"code": "request", "cid": 1, "adr": "${adr}"}`;
}

async function getValue(endpoint, requestBody) {
	// @ts-ignore
	const res = await axios({
		method: 'post',
		url: `http://${endpoint}`,
		timeout: 8000,
		data: requestBody,
		headers: {'content-type': 'application/json'}
	});
	return res.data['data']['value'];
}

async function getSensorPortMap(ipOfIOLink) {
	const sensorIdPortMap = new Map();
	for (let i = 1; i <= CONFIG.Ports; i++) {
		const sensorPort = i;
		const productName = await getValue(ipOfIOLink, getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/productname/getdata`));
		if (CONFIG.Sensors.includes(productName))
			sensorIdPortMap.set(sensorPort, productName);
		else
			throw new UnidentifiedSensorError('Could not find Sensor: ' + productName + ' in Config!');
	}
	return sensorIdPortMap;
}

function roundNumberTwoDigits(number) {
	return Number((Math.round(number * 100) / 100).toFixed(2));
}

function parseHexToInt16(number) {
	const int16 = parseInt(number, 16);
	if ((int16 & 0x8000) > 0) {
		return (int16 - 0x10000);
	}
	return int16;
}

async function getValueForSensor135(sensorPort, endpoint) {
	const hexString = await getValue(endpoint, getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`));
	const humiditySub = hexString.substring(0, 4);
	let humidity = parseHexToInt16(humiditySub);
	humidity = humidity * 0.1;

	const tempSub = hexString.substring(8, 12);
	let temp = parseHexToInt16(tempSub);
	temp = temp * 0.1;

	return [humidity, temp];
}

async function getValueForSensor6(sensorPort, endpoint) {
	const hexString = await getValue(endpoint, getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`));
	const temperatureFlow = parseHexToInt16(hexString);
	return (temperatureFlow * 0.1);
}

async function getValueForSensor25(sensorPort, endpoint) {
	const hexString = await getValue(endpoint, getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`));
	const wordZero = parseInt(hexString.substring(0, 4), 16);
	return (wordZero >> 2);
}

async function getValueForSensor48(sensorPort, endpoint) {
	const hexString = await getValue(endpoint, getRequestBody(`/iolinkmaster/port[${sensorPort}]/iolinkdevice/pdin/getdata`));
	const flow = parseHexToInt16(hexString.substring(0, 4));
	const temperatureReturn = ((parseInt(hexString.substring(4, 8), 16)) >> 2) * 0.1;
	return [flow, temperatureReturn];
}

async function checkIsHostAlive(endpoint) {
	try {
		await getValue(endpoint, getRequestBody(`/deviceinfo/productcode/getdata`));
		return true;
	} catch (error) {
		return false;
	}
}

async function initHost(ipOfIOLink) {
	if (await checkIsHostAlive(ipOfIOLink))
		return true;
	else
		return false;
}

class IoLinkMasterAl1370 extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'io-link-master-al1370',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {

		this.log.info('config option2: ' + this.config.ioLinkIp);
		const ipOfIOLink = this.config.ioLinkIp, sleepTimer = this.config.sleepTimer;
		const hostAlive = true;

		if (!(await initHost(ipOfIOLink))) {
			this.log.error('Could not initialise Host! Shutting adapter down!');
			this.stop;
		}

		const prefix = 'Ports';
		await this.setObjectNotExistsAsync(prefix, {
			type: 'channel',
			common: {
				name: 'Sensors',
			},
			native: {},
		});

		// let sensorPortMap = null;
		// await getSensorPortMap(ipOfIOLink)
		// 	.then(sensorPortMapReturn => {
		// 		this.log.info('test');
		// 		sensorPortMap = sensorPortMapReturn;
		// 		sensorPortMap.forEach((value, key) => {
		// 			this.setObjectNotExists(`${prefix}.Port${key}`, {
		// 				type: 'state',
		// 				common: {
		// 					name: `Port${key}`,
		// 					type: 'string',
		// 					role: 'value.SensorName',
		// 					read: true,
		// 					write: false,
		// 				},
		// 				native: {},
		// 			});
		// 			this.setState(`${prefix}.Port${key}`, {
		// 				val: value,
		// 				ack: true
		// 			});
		// 		});
		// 	})
		// 	.catch(err => this.log.error(err))
		// 	.finally(() => {
		// 		this.log.warn('Please check the sensors or config!');
		// 	});
		while (hostAlive) {
			const start = performance.now();
			let tempFlow = null;
			let tempReturn = null;
			await this.setObjectNotExistsAsync('isHostAlive', {
				type: 'state',
				common: {
					name: 'isHostAlive',
					type: 'boolean',
					role: 'value.isHostAlive',
					read: true,
					write: false,
				},
				native: {},
			});
			this.subscribeStates('isHostAlive');
			if (await checkIsHostAlive(ipOfIOLink)) {
				const getLastState = await this.getStateAsync('isHostAlive');
				if (getLastState == null) {
					await this.setStateAsync('isHostAlive', {val: true, ack: true});
				} else {
					if (getLastState.val === false)
						await this.setStateAsync('isHostAlive', {val: true, ack: true});
				}
			} else {
				await this.setStateAsync('isHostAlive', {val: false, ack: true});
				this.log.error('Host went down! Trying again in: ' + sleepTimer + 'ms');
				await sleep(sleepTimer);
				continue;
			}
			await getSensorPortMap(ipOfIOLink).then(async (sensorPortMap) => {
				this.log.error('DO SOMETHING!!!!!');
				for (const [sensorPort, productName] of sensorPortMap) {
					this.log.info(productName);
					if (productName === 'AH002') {
						const resultSensor135 = await getValueForSensor135(1, ipOfIOLink);
						const humidityRack = resultSensor135[0];
						const temperatureRack = resultSensor135[1];
						await this.setObjectNotExistsAsync('temperatureRack', {
							type: 'state',
							common: {
								name: 'temperatureRack',
								type: 'number',
								role: 'value.temperatureRack',
								unit: '°C',
								read: true,
								write: false,
							},
							native: {},
						});
						//TODO: identifier infront of all states to just subscribe to identifier.*
						this.subscribeStates('temperatureRack');
						await this.setStateAsync('temperatureRack', {
							val: roundNumberTwoDigits(temperatureRack),
							ack: true
						});

						await this.setObjectNotExistsAsync('humidityRack', {
							type: 'state',
							common: {
								name: 'humidityRack',
								type: 'number',
								role: 'value.humidityRack',
								unit: '%',
								read: true,
								write: false,
							},
							native: {},
						});
						this.subscribeStates('humidityRack');
						await this.setStateAsync('humidityRack', {val: roundNumberTwoDigits(humidityRack), ack: true});
					} else if (productName === 'AT001') {
						const temperatureFlow = await getValueForSensor6(sensorPort, ipOfIOLink);
						tempFlow = temperatureFlow;
						await this.setObjectNotExistsAsync('temperatureFlow', {
							type: 'state',
							common: {
								name: 'temperatureFlow',
								type: 'number',
								role: 'value.temperatureFlow',
								unit: '°C',
								read: true,
								write: false,
							},
							native: {},
						});
						this.subscribeStates('temperatureFlow');
						await this.setStateAsync('temperatureFlow', {
							val: roundNumberTwoDigits(temperatureFlow),
							ack: true
						});
					} else if (productName === 'AP011') {
						const pressure = await getValueForSensor25(sensorPort, ipOfIOLink);
						await this.setObjectNotExistsAsync('pressure', {
							type: 'state',
							common: {
								name: 'Pressure',
								type: 'number',
								role: 'value.pressure',
								unit: 'Bar',
								read: true,
								write: false,
							},
							native: {},
						});
						this.subscribeStates('pressure');
						await this.setStateAsync('pressure', {val: roundNumberTwoDigits(pressure), ack: true});
					} else if (productName === 'AS005_LIQU') {
						//TODO: handel ul ol thingy
						const resultSensor48 = await getValueForSensor48(sensorPort, ipOfIOLink);
						const flow = resultSensor48[0];
						const temperatureReturn = resultSensor48[1];
						tempReturn = temperatureReturn;

						await this.setObjectNotExistsAsync('flow', {
							type: 'state',
							common: {
								name: 'flow',
								type: 'number',
								role: 'value.flow',
								unit: 'l/h',
								read: true,
								write: false,
							},
							native: {},
						});
						this.subscribeStates('flow');
						await this.setStateAsync('flow', {val: roundNumberTwoDigits(flow), ack: true});

						await this.setObjectNotExistsAsync('temperatureReturn', {
							type: 'state',
							common: {
								name: 'temperatureReturn',
								type: 'number',
								role: 'value.temperatureReturn',
								unit: '°C',
								read: true,
								write: false,
							},
							native: {},
						});
						this.subscribeStates('temperatureReturn');
						await this.setStateAsync('temperatureReturn', {
							val: roundNumberTwoDigits(temperatureReturn),
							ack: true
						});

					} else {
						throw new Error('unidentified sensor');
					}
				}

			});
			// for (const [sensorPort, productName] of sensorPortMap) {
			// 	this.log.info(productName);
			// 	if (productName === 'AH002') {
			// 		const resultSensor135 = await getValueForSensor135(1, ipOfIOLink);
			// 		const humidityRack = resultSensor135[0];
			// 		const temperatureRack = resultSensor135[1];
			// 		await this.setObjectNotExistsAsync('temperatureRack', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'temperatureRack',
			// 				type: 'number',
			// 				role: 'value.temperatureRack',
			// 				unit: '°C',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		//TODO: identifier infront of all states to just subscribe to identifier.*
			// 		this.subscribeStates('temperatureRack');
			// 		await this.setStateAsync('temperatureRack', {
			// 			val: roundNumberTwoDigits(temperatureRack),
			// 			ack: true
			// 		});
			//
			// 		await this.setObjectNotExistsAsync('humidityRack', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'humidityRack',
			// 				type: 'number',
			// 				role: 'value.humidityRack',
			// 				unit: '%',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		this.subscribeStates('humidityRack');
			// 		await this.setStateAsync('humidityRack', {val: roundNumberTwoDigits(humidityRack), ack: true});
			// 	} else if (productName === 'AT001') {
			// 		const temperatureFlow = await getValueForSensor6(sensorPort, ipOfIOLink);
			// 		tempFlow = temperatureFlow;
			// 		await this.setObjectNotExistsAsync('temperatureFlow', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'temperatureFlow',
			// 				type: 'number',
			// 				role: 'value.temperatureFlow',
			// 				unit: '°C',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		this.subscribeStates('temperatureFlow');
			// 		await this.setStateAsync('temperatureFlow', {
			// 			val: roundNumberTwoDigits(temperatureFlow),
			// 			ack: true
			// 		});
			// 	} else if (productName === 'AP011') {
			// 		const pressure = await getValueForSensor25(sensorPort, ipOfIOLink);
			// 		await this.setObjectNotExistsAsync('pressure', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'Pressure',
			// 				type: 'number',
			// 				role: 'value.pressure',
			// 				unit: 'Bar',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		this.subscribeStates('pressure');
			// 		await this.setStateAsync('pressure', {val: roundNumberTwoDigits(pressure), ack: true});
			// 	} else if (productName === 'AS005_LIQU') {
			// 		//TODO: handel ul ol thingy
			// 		const resultSensor48 = await getValueForSensor48(sensorPort, ipOfIOLink);
			// 		const flow = resultSensor48[0];
			// 		const temperatureReturn = resultSensor48[1];
			// 		tempReturn = temperatureReturn;
			//
			// 		await this.setObjectNotExistsAsync('flow', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'flow',
			// 				type: 'number',
			// 				role: 'value.flow',
			// 				unit: 'l/h',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		this.subscribeStates('flow');
			// 		await this.setStateAsync('flow', {val: roundNumberTwoDigits(flow), ack: true});
			//
			// 		await this.setObjectNotExistsAsync('temperatureReturn', {
			// 			type: 'state',
			// 			common: {
			// 				name: 'temperatureReturn',
			// 				type: 'number',
			// 				role: 'value.temperatureReturn',
			// 				unit: '°C',
			// 				read: true,
			// 				write: false,
			// 			},
			// 			native: {},
			// 		});
			// 		this.subscribeStates('temperatureReturn');
			// 		await this.setStateAsync('temperatureReturn', {
			// 			val: roundNumberTwoDigits(temperatureReturn),
			// 			ack: true
			// 		});
			//
			// 	} else {
			// 		throw new Error('unidentified sensor');
			// 	}
			// }

			if (tempFlow != null && tempReturn != null) {
				const temperatureDelta = tempReturn - tempFlow;

				await this.setObjectNotExistsAsync('temperatureDelta', {
					type: 'state',
					common: {
						name: 'temperatureDelta',
						type: 'number',
						role: 'value.temperatureDelta',
						unit: '°C',
						read: true,
						write: false,
					},
					native: {},
				});
				this.subscribeStates('temperatureDelta');
				await this.setStateAsync('temperatureDelta', {val: roundNumberTwoDigits(temperatureDelta), ack: true});
			}

			const end = performance.now();
			this.log.info('Finished run in: ' + (end - start) + 'ms');
			this.log.info('Going to sleep now for: ' + sleepTimer + 'ms');
			await sleep(sleepTimer);
		}
		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/
		await this.setObjectNotExistsAsync('testVariable', {
			type: 'state',
			common: {
				name: 'testVariable',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: true,
			},
			native: {},
		});

		// // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		// this.subscribeStates('testVariable');
		// // You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		// // this.subscribeStates('lights.*');
		// // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
		// // this.subscribeStates('*');
		//
		// /*
		// 	setState examples
		// 	you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		// */
		// // the variable testVariable is set to true as command (ack=false)
		// await this.setStateAsync('testVariable', true);
		//
		// // same thing, but the value is flagged "ack"
		// // ack should be always set to true if the value is received from or acknowledged from the target system
		// await this.setStateAsync('testVariable', {val: true, ack: true});
		//
		// // same thing, but the state is deleted after 30s (getState will return null afterwards)
		// await this.setStateAsync('testVariable', {val: true, ack: true, expire: 30});
		//
		// // examples for the checkPassword/checkGroup functions
		// let result = await this.checkPasswordAsync('admin', 'iobroker');
		// this.log.info('check user admin pw iobroker: ' + result);
		//
		// result = await this.checkGroupAsync('admin', 'admin');
		// this.log.info('check group user admin group admin: ' + result);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new IoLinkMasterAl1370(options);
} else {
	// otherwise start the instance directly
	new IoLinkMasterAl1370();
}