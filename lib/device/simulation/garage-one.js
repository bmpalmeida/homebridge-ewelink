import platformConsts from '../../utils/constants.js'
import { hasProperty, sleep } from '../../utils/functions.js'

// Reading the gate's last report from the cloud (#760)
const CLOUD_COMMAND_TIMEOUT_MS = 3000
const CLOUD_READ_TIMEOUT_MS = 10000
const CLOUD_FAST_MS = 30000
const CLOUD_SLOW_MS = 120000
const CLOUD_RECENT_MS = 120000

export default class {
  constructor(platform, accessory) {
    // Set up variables from the platform
    this.eveChar = platform.eveChar
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.hapUUIDGen = platform.api.hap.uuid.generate
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.name = accessory.displayName
    this.accessory = accessory

    // Initially set the online flag as true (to be then updated as false if necessary)
    this.isOnline = true

    // Set up custom variables for this device type
    const deviceConf = platform.deviceConf[accessory.context.eweDeviceId] || {}
    this.operationTimeUp = deviceConf.operationTime || platformConsts.defaultValues.operationTime
    this.operationTimeDown = deviceConf.operationTimeDown || this.operationTimeUp

    // Some users' garage door reports the opposite state to reality (e.g. a
    // MINI-D wired to the NO contact). This option swaps the reported open and
    // closed states for this device.
    this.invertGarage = deviceConf.invertGarageState === true

    // Set the correct logging variables for this accessory
    switch (deviceConf.overrideLogging) {
      case 'standard':
        this.enableLogging = true
        this.enableDebugLogging = false
        break
      case 'debug':
        this.enableLogging = true
        this.enableDebugLogging = true
        break
      case 'disable':
        this.enableLogging = false
        this.enableDebugLogging = false
        break
      default:
        this.enableLogging = !platform.config.disableDeviceLogging
        this.enableDebugLogging = false
        break
    }

    // Check the sensor is valid if defined by the user
    if (deviceConf.sensorId) {
      this.definedSensor = true
    }

    // If the accessory has a switch service then remove it
    if (this.accessory.getService(this.hapServ.Switch)) {
      this.accessory.removeService(this.accessory.getService(this.hapServ.Switch))
    }

    // If the accessory has a contact sensor service then remove it
    if (this.accessory.getService(this.hapServ.ContactSensor)) {
      this.accessory.removeService(this.accessory.getService(this.hapServ.ContactSensor))
    }

    // Add the garage door service if it doesn't already exist
    this.service = this.accessory.getService(this.hapServ.GarageDoorOpener)
    if (!this.service) {
      this.service = this.accessory.addService(this.hapServ.GarageDoorOpener)
      this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(1))
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(1))
      this.service.updateCharacteristic(this.hapChar.ObstructionDetected, false)
      this.service.addCharacteristic(this.eveChar.LastActivation)
      this.service.addCharacteristic(this.eveChar.ResetTotal)
      this.service.addCharacteristic(this.eveChar.TimesOpened)
    }

    // Remove unneeded characteristics
    if (this.service.testCharacteristic(this.hapChar.ContactSensorState)) {
      this.service.removeCharacteristic(
        this.service.getCharacteristic(this.hapChar.ContactSensorState),
      )
    }
    if (this.service.testCharacteristic(this.hapChar.OpenDuration)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(this.hapChar.OpenDuration))
    }
    if (this.service.testCharacteristic(this.hapChar.ClosedDuration)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(this.hapChar.ClosedDuration))
    }

    // Set up the device type and power readings if necessary
    if (platformConsts.devices.switchSingle.includes(this.accessory.context.eweUIID)) {
      this.setup = 'switchSingle'
    } else if (platformConsts.devices.switchSinglePower.includes(this.accessory.context.eweUIID)) {
      this.setup = 'switchSingle'

      // Add Eve power characteristics
      this.powerReadings = true
      if (!this.service.testCharacteristic(this.eveChar.CurrentConsumption)) {
        this.service.addCharacteristic(this.eveChar.CurrentConsumption)
      }
      if (this.accessory.context.eweUIID === 32) {
        if (!this.service.testCharacteristic(this.eveChar.ElectricCurrent)) {
          this.service.addCharacteristic(this.eveChar.ElectricCurrent)
        }
        if (!this.service.testCharacteristic(this.eveChar.Voltage)) {
          this.service.addCharacteristic(this.eveChar.Voltage)
        }
      }
    } else if (platformConsts.devices.switchMulti.includes(this.accessory.context.eweUIID)) {
      this.setup = 'switchMulti'
      if (platformConsts.devices.switchMultiPower.includes(this.accessory.context.eweUIID)) {
        // Add Eve power characteristics
        this.powerReadings = true
        if (!this.service.testCharacteristic(this.eveChar.CurrentConsumption)) {
          this.service.addCharacteristic(this.eveChar.CurrentConsumption)
        }
        if (!this.service.testCharacteristic(this.eveChar.ElectricCurrent)) {
          this.service.addCharacteristic(this.eveChar.ElectricCurrent)
        }
        if (!this.service.testCharacteristic(this.eveChar.Voltage)) {
          this.service.addCharacteristic(this.eveChar.Voltage)
        }
        this.isDualR3 = true
      }
    } else if (platformConsts.devices.switchSCM.includes(this.accessory.context.eweUIID)) {
      this.setup = 'switchMulti'
    } else if (platformConsts.devices.switchSCMPower.includes(this.accessory.context.eweUIID)) {
      // Could do power here
      this.setup = 'switchMulti'
    }

    // Some devices keep their switch on or off rather than acting as a momentary
    // pulse (e.g. the electric gate controller, uiid 216, where the switch is on
    // after an open order and off after a close order). With this option the
    // switch is the last order given: it flips as soon as the order is given, not
    // when the gate has finished moving. If the device also reports doorState
    // (0 when the gate is closed, 1 otherwise), the shown state is doorState
    // alone, and a command opens a closed gate or closes an open one. Without
    // doorState, the switch is followed and both ways take the operation time.
    // Only for single channel devices, and a contact sensor still takes priority.
    this.switchIsState = deviceConf.switchIsState === true
      && this.setup === 'switchSingle'
      && !this.definedSensor

    // Add the set handler to the garage door reset total characteristic
    this.service.getCharacteristic(this.eveChar.ResetTotal).onSet(() => {
      this.service.updateCharacteristic(this.eveChar.TimesOpened, 0)
    })

    // Add the set handler to the target position characteristic
    this.service.getCharacteristic(this.hapChar.TargetDoorState).onSet((value) => {
      // We don't use await as we want the callback to be run straight away.
      // Map the HomeKit target to the internal logical position first.
      this.internalUpdate(this.invPos(value))
    })

    // Add the get handlers only if the user hasn't disabled the disableNoResponse setting
    if (!platform.config.disableNoResponse) {
      this.service.getCharacteristic(this.hapChar.CurrentDoorState).onGet(() => {
        if (!this.isOnline) {
          throw new this.hapErr(-70402)
        }
        return this.service.getCharacteristic(this.hapChar.CurrentDoorState).value
      })
      this.service.getCharacteristic(this.hapChar.TargetDoorState).onGet(() => {
        if (!this.isOnline) {
          throw new this.hapErr(-70402)
        }
        return this.service.getCharacteristic(this.hapChar.TargetDoorState).value
      })
    }

    // Pass the accessory to Fakegato to set up with Eve
    this.accessory.eveService = new platform.eveService('door', this.accessory, {
      log: () => {},
    })
    this.accessory.eveService.addEntry({
      status: this.service.getCharacteristic(this.hapChar.CurrentDoorState).value === 0 ? 0 : 1,
    })

    // A gate controller may not answer a web socket query, leaving the state
    // shown at startup (or after a failed order) wrong for good. Its last report
    // stays in the cloud, so read it from there too: now, then every 2 minutes,
    // or every 30 s while an order was sent in the last 2 minutes
    if (this.switchIsState && platform.httpClient) {
      this.cloudTimeout = setTimeout(() => this.readCloud(), 15000)
      this.intervalCloud = setInterval(() => this.cloudTick(), CLOUD_FAST_MS)
    }

    // Set up an interval to get eWeLink to send power updates
    if (
      this.powerReadings
      && (!this.isDualR3 || (this.isDualR3 && platform.config.mode !== 'lan'))
    ) {
      setTimeout(() => {
        this.internalUIUpdate()
        this.intervalPoll = setInterval(() => this.internalUIUpdate(), 120000)
      }, 5000)
    }

    // Output the customised options to the log
    const normalLogging = this.enableLogging ? 'standard' : 'disable'
    const opts = JSON.stringify({
      logging: this.enableDebugLogging ? 'debug' : normalLogging,
      operationTimeDown: this.operationTimeDown,
      operationTimeUp: this.operationTimeUp,
      showAs: 'garage',
      ...(this.switchIsState && { switchIsState: true }),
    })
    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, opts)
  }

  // Swap Open<->Closed and Opening<->Closing when this device is inverted.
  // This is an involution, so the same function maps a HomeKit-facing value to
  // the internal logical value and back. A no-op when inversion is disabled, or
  // when a contact sensor is defined (the sensor already reports the real state).
  invPos(pos) {
    if (!this.invertGarage || this.definedSensor) {
      return pos
    }
    switch (pos) {
      case 0:
        return 1
      case 1:
        return 0
      case 2:
        return 3
      case 3:
        return 2
      default:
        return pos
    }
  }

  async internalUpdate(value) {
    if (this.switchIsState) {
      await this.internalStateUpdate(value)
      return
    }
    try {
      const newPos = value
      const params = {}
      let delay = 0
      const prevState = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
      if (newPos === prevState % 2) {
        return
      }
      this.inUse = true
      this.cacheState = value
      if (this.setup === 'switchSingle' && [2, 3].includes(prevState)) {
        this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(((prevState * 2) % 3) + 2))
        delay = 1500
      }
      if (this.cacheState !== newPos) {
        return
      }
      await sleep(delay)
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(newPos))
      this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos + 2))
      // SCM (single-channel multi-format) devices use the switches[] array
      // but only expose outlet 0. True dual-channel garage controllers
      // (e.g. DUALR3) use separate outlets for open/close relay action.
      const isScm = platformConsts.devices.switchSCM.includes(this.accessory.context.eweUIID)
        || platformConsts.devices.switchSCMPower.includes(this.accessory.context.eweUIID)

      switch (this.setup) {
        case 'switchSingle':
          params.switch = 'on'
          break
        case 'switchMulti':
          if (isScm) {
            // SCM device: send a single momentary pulse on outlet 0
            params.switches = [{ switch: 'on', outlet: 0 }]
          } else {
            // Dual-channel device with separate open/close relays
            params.switches = [
              {
                switch: newPos === 0 ? 'on' : 'off',
                outlet: 0,
              },
              {
                switch: newPos === 1 ? 'on' : 'off',
                outlet: 1,
              },
            ]
          }
          break
        default:
          return
      }
      await this.platform.sendDeviceUpdate(this.accessory, params)
      await sleep(2000)
      this.inUse = false
      if (!this.definedSensor && newPos === 0) {
        this.accessory.eveService.addEntry({ status: 0 })
        const initialTime = this.accessory.eveService.getInitialTime()
        this.service.updateCharacteristic(
          this.eveChar.LastActivation,
          Math.round(new Date().valueOf() / 1000) - initialTime,
        )
        this.service.updateCharacteristic(
          this.eveChar.TimesOpened,
          this.service.getCharacteristic(this.eveChar.TimesOpened).value + 1,
        )
      }
      const operationTime = newPos === 0 ? this.operationTimeUp : this.operationTimeDown
      await sleep(Math.max((operationTime - 20) * 100, 0))
      if (!this.definedSensor) {
        this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos))
        if (newPos === 1) {
          this.accessory.eveService.addEntry({ status: 1 })
        }
        if (this.enableLogging) {
          this.log(
            '[%s] %s [%s].',
            this.name,
            this.lang.curState,
            this.invPos(newPos) === 0 ? this.lang.doorOpen : this.lang.doorClosed,
          )
        }
      }
    } catch (err) {
      this.inUse = false
      this.platform.deviceUpdateError(this.accessory, err, true)
      setTimeout(() => {
        this.service.updateCharacteristic(
          this.hapChar.TargetDoorState,
          this.service.getCharacteristic(this.hapChar.TargetDoorState).value,
        )
      }, 2000)
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, new this.hapErr(-70402))
    }
  }

  // Used when the device's switch is the last order: open turns the switch on and
  // close turns it off. With the closed limit (doorState) the gate is simply
  // opened when it is closed and closed when it is open, from a fresh read of
  // its state; the shown state only ever comes from doorState (#760).
  async internalStateUpdate(newPos) {
    const prevState = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    try {
      // The fresh state from the cloud, or the last known one if the read fails
      const params = await this.fetchCloud(CLOUD_COMMAND_TIMEOUT_MS)
      if (params) {
        this.takeParams(params)
      }

      if (this.hasDoorState) {
        const isClosed = this.lastDoorState === 0
        if ((newPos === 0) !== isClosed) {
          // Already there: show it, send nothing
          setTimeout(this.showDoorState.bind(this), 0, false)
          return
        }
      } else {
        // Without doorState: nothing to do if the door is there or already on
        // its way (a stopped door can be sent either way)
        if (newPos === prevState || newPos + 2 === prevState) {
          return
        }
        this.startTravel(newPos)
      }

      // The device only acts when the order changes. If its last order is already
      // the wanted one (e.g. on, and the gate was then closed by its remote),
      // send the opposite one first: the gate is already there, so it does
      // nothing; then the wanted one is a change and the gate moves (#760).
      const target = newPos === 0 ? 'on' : 'off'
      this.lastCommandAt = Date.now()
      if (this.lastSwitch === target) {
        this.ignoreSwitchUntil = Date.now() + 4000
        await this.sendOrder({ switch: target === 'on' ? 'off' : 'on' })
        const gap = this.orderGapMs ?? 1000
        if (gap > 0) {
          await new Promise(resolve => setTimeout(resolve, gap))
        }
      }
      await this.sendOrder({ switch: target })
      this.lastSwitch = target
    } catch (err) {
      // The command did not reach the device, so the door is where it was
      clearTimeout(this.stateTimeout)
      this.stateTimeout = undefined
      this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(prevState))
      this.platform.deviceUpdateError(this.accessory, err, true)
      setTimeout(() => {
        if (this.hasDoorState) {
          this.showDoorState(false)
        } else {
          this.service.updateCharacteristic(
            this.hapChar.TargetDoorState,
            this.invPos(prevState === 4 ? 1 : prevState % 2),
          )
        }
      }, 2000)
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, new this.hapErr(-70402))
    }
  }

  // Without doorState: show the door moving towards open (0) or closed (1), and
  // settle on it after the operation time. A movement already under way to the
  // same position keeps its timer, while a different one replaces it.
  startTravel(newPos) {
    const current = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    if (current === newPos || (current === newPos + 2 && this.stateTimeout)) {
      return
    }
    clearTimeout(this.stateTimeout)
    this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(newPos))
    this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos + 2))
    const operationTime = newPos === 0 ? this.operationTimeUp : this.operationTimeDown
    this.stateTimeout = setTimeout(() => {
      this.stateTimeout = undefined
      this.applySwitchState(newPos, true)
    }, operationTime * 100)
  }

  // With doorState, the shown state is doorState and nothing else: on the
  // closed limit (0) closed, off it (1) open, current and target alike
  showDoorState(isLive) {
    const newPos = this.lastDoorState === 0 ? 1 : 0
    const current = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    const target = this.invPos(this.service.getCharacteristic(this.hapChar.TargetDoorState).value)
    if (current === newPos && target === newPos && !this.stateTimeout) {
      return
    }
    this.applySwitchState(newPos, isLive && current !== newPos)
  }

  // Without doorState, work out the door from the last order (switch). isLive
  // is false for the state read at startup (or from the cloud), which is shown
  // as it is rather than as a movement.
  followSwitch(isLive) {
    const sw = this.lastSwitch
    if (!sw) {
      return
    }
    const newPos = sw === 'on' ? 0 : 1
    const current = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    if (isLive) {
      this.startTravel(newPos)
    } else if (current !== newPos) {
      this.applySwitchState(newPos, false)
    }
  }

  // Show the door as fully open (0) or closed (1), as the switch says. isLive is
  // false for the state read at startup, which is not a new door movement.
  applySwitchState(newPos, isLive) {
    clearTimeout(this.stateTimeout)
    this.stateTimeout = undefined
    this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(newPos))
    this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos))
    this.accessory.eveService.addEntry({ status: newPos })
    if (isLive && newPos === 0) {
      const initialTime = this.accessory.eveService.getInitialTime()
      this.service.updateCharacteristic(
        this.eveChar.LastActivation,
        Math.round(new Date().valueOf() / 1000) - initialTime,
      )
      this.service.updateCharacteristic(
        this.eveChar.TimesOpened,
        this.service.getCharacteristic(this.eveChar.TimesOpened).value + 1,
      )
    }
    if (isLive && this.enableLogging) {
      this.log(
        '[%s] %s [%s].',
        this.name,
        this.lang.curState,
        this.invPos(newPos) === 0 ? this.lang.doorOpen : this.lang.doorClosed,
      )
    }
  }

  async internalUIUpdate() {
    try {
      // Skip polling if device isn't online
      if (!this.isOnline) {
        return
      }

      // Send the params to request the updates
      if (this.isDualR3) {
        await this.platform.sendDeviceUpdate(this.accessory, { uiActive: { outlet: 0, time: 120 } })
      } else {
        await this.platform.sendDeviceUpdate(this.accessory, { uiActive: 120 })
      }
    } catch (err) {
      // Suppress errors here
    }
  }

  async externalUpdate(params) {
    try {
      if (this.powerReadings) {
        let logger = false
        let power
        let voltage
        let current
        if (hasProperty(params, 'actPow_00')) {
          power = Number.parseInt(params.actPow_00, 10) / 100
          this.service.updateCharacteristic(this.eveChar.CurrentConsumption, power)
          logger = true
        } else if (hasProperty(params, 'power')) {
          power = Number.parseFloat(params.power)
          this.service.updateCharacteristic(this.eveChar.CurrentConsumption, power)
          logger = true
        }
        if (hasProperty(params, 'voltage_00')) {
          voltage = Number.parseInt(params.voltage_00, 10) / 100
          this.service.updateCharacteristic(this.eveChar.Voltage, voltage)
          logger = true
        } else if (hasProperty(params, 'voltage')) {
          voltage = Number.parseFloat(params.voltage)
          this.service.updateCharacteristic(this.eveChar.Voltage, voltage)
          logger = true
        }
        if (hasProperty(params, 'current_00')) {
          current = Number.parseInt(params.current_00, 10) / 100
          this.service.updateCharacteristic(this.eveChar.ElectricCurrent, current)
          logger = true
        } else if (hasProperty(params, 'current')) {
          current = Number.parseFloat(params.current)
          this.service.updateCharacteristic(this.eveChar.ElectricCurrent, current)
          logger = true
        }
        if (params.updateSource && logger && this.enableLogging) {
          this.log(
            '[%s] %s%s%s.',
            this.name,
            power !== undefined ? `${this.lang.curPower} [${power}W]` : '',
            voltage !== undefined ? ` ${this.lang.curVolt} [${voltage}V]` : '',
            current !== undefined ? ` ${this.lang.curCurr} [${current}A]` : '',
          )
        }
      }

      if (this.switchIsState) {
        // The switch is the last order: on is open, off is close. The gate
        // controller also sends doorState, 0 on its closed limit and 1 off it.
        // A report may carry only one of the two, so the last of each is kept.
        const { hasSwitch, hasDoorState } = this.takeParams(params)
        if (this.hasDoorState) {
          if (hasDoorState) {
            this.showDoorState(!!params.updateSource)
          }
        } else if (hasSwitch) {
          this.followSwitch(!!params.updateSource)
        }
        return
      }

      if (!this.inUse && !this.definedSensor) {
        const prevState = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
        const newPos = [0, 2].includes(prevState) ? 3 : 2
        if (this.setup === 'switchMulti' && params.switches?.length >= 2) {
          if (
            params.switches[0].switch === params.switches[1].switch
            || params.switches[prevState % 2].switch === 'on'
          ) {
            return
          }
        } else if (this.setup === 'switchSingle' && params.switch) {
          if (params.switch === 'off') {
            return
          }
        } else {
          return
        }
        this.inUse = true
        this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(newPos - 2))
        this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos))
        await sleep(2000)
        this.inUse = false
        if (newPos === 2) {
          this.accessory.eveService.addEntry({ status: 0 })
          const initialTime = this.accessory.eveService.getInitialTime()
          this.service.updateCharacteristic(
            this.eveChar.LastActivation,
            Math.round(new Date().valueOf() / 1000) - initialTime,
          )
          this.service.updateCharacteristic(
            this.eveChar.TimesOpened,
            this.service.getCharacteristic(this.eveChar.TimesOpened).value + 1,
          )
        }
        const operationTime = newPos === 2 ? this.operationTimeUp : this.operationTimeDown
        await sleep(Math.max((operationTime - 20) * 100, 0))
        this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(newPos - 2))
        if (newPos === 3) {
          this.accessory.eveService.addEntry({ status: 1 })
        }
        if (this.enableLogging) {
          this.log(
            '[%s] %s [%s].',
            this.name,
            this.lang.curState,
            newPos === 2 ? this.lang.doorOpen : this.lang.doorClosed,
          )
        }
      }
    } catch (err) {
      this.inUse = false
      this.platform.deviceUpdateError(this.accessory, err, false)
    }
  }

  // Keep the last switch and doorState of a report (or a cloud read)
  takeParams(params) {
    const hasSwitch = params.switch === 'on' || params.switch === 'off'
    const doorState = Number(params.doorState)
    const hasDoorState = hasProperty(params, 'doorState') && [0, 1].includes(doorState)
    // The echo of the opposite order sent just before the wanted one is not a
    // new order from the device
    const echo = this.ignoreSwitchUntil && Date.now() < this.ignoreSwitchUntil
    if (hasSwitch && !echo) {
      this.lastSwitch = params.switch
    }
    if (hasDoorState) {
      this.lastDoorState = doorState
      this.hasDoorState = true
    }
    return { hasSwitch, hasDoorState }
  }

  // The device's last report from the cloud (switch and doorState), or
  // undefined if it cannot be read within timeoutMs
  async fetchCloud(timeoutMs) {
    if (!this.platform.httpClient) {
      return undefined
    }
    let timer
    try {
      const params = await Promise.race([
        this.platform.httpClient.getDeviceParams(this.accessory.context.eweDeviceId),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs, undefined)
        }),
      ])
      if (!params || (params.switch === undefined && params.doorState === undefined)) {
        return undefined
      }
      const read = {}
      if (params.switch !== undefined) {
        read.switch = params.switch
      }
      if (params.doorState !== undefined) {
        read.doorState = params.doorState
      }
      return read
    } catch (err) {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  // Every 30 s while an order was sent in the last 2 minutes, else every 2
  // minutes, read the last report from the cloud, so the shown state catches
  // up even if a web socket report is lost
  cloudTick() {
    const now = Date.now()
    const recentOrder = this.lastCommandAt && now - this.lastCommandAt < CLOUD_RECENT_MS
    if (recentOrder || !this.lastCloudReadAt || now - this.lastCloudReadAt >= CLOUD_SLOW_MS - CLOUD_FAST_MS / 2) {
      this.readCloud()
    }
  }

  async readCloud() {
    this.lastCloudReadAt = Date.now()
    // Without doorState, a stored report must not cut short a movement
    if (this.stateTimeout) {
      return
    }
    const params = await this.fetchCloud(CLOUD_READ_TIMEOUT_MS)
    if (params) {
      await this.externalUpdate(params)
    }
  }

  // Send an order, through the cloud's http api when the web socket fails
  async sendOrder(params) {
    try {
      await this.platform.sendDeviceUpdate(this.accessory, params)
    } catch (err) {
      if (!this.platform.httpClient) {
        throw err
      }
      await this.platform.httpClient.updateDevice(this.accessory.context.eweDeviceId, params)
    }
  }

  destroy() {
    clearInterval(this.intervalPoll)
    clearInterval(this.intervalCloud)
    clearTimeout(this.cloudTimeout)
    clearTimeout(this.stateTimeout)
  }

  markStatus(isOnline) {
    this.isOnline = isOnline
  }
}
