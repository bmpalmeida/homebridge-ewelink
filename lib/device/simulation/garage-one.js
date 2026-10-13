import platformConsts from '../../utils/constants.js'
import { hasProperty, sleep } from '../../utils/functions.js'

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
    // (0 when the gate is closed, 1 otherwise), that closed limit decides when the
    // gate is closed. There is no open limit, so opening always takes the
    // operation time. Without doorState, both ways take the operation time.
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
  // close turns it off. The door moves now, as the device's own report of the
  // order may come later or not at all.
  async internalStateUpdate(newPos) {
    const prevState = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    try {
      // Nothing to do if the door is there or already on its way (a stopped door
      // can be sent either way). A close is still sent when the door is shown
      // closed but the gate is not on its closed limit, as the shown state may
      // be wrong and the user must always be able to close the gate.
      const offClosedLimit = this.hasDoorState && this.lastDoorState !== 0
      if ((newPos === prevState && !(newPos === 1 && offClosedLimit)) || newPos + 2 === prevState) {
        return
      }
      if (newPos === 1 && this.hasDoorState) {
        this.startClosing()
      } else {
        this.startTravel(newPos)
      }
      await this.platform.sendDeviceUpdate(this.accessory, { switch: newPos === 0 ? 'on' : 'off' })
    } catch (err) {
      // The command did not reach the device, so its switch, and the door, are
      // where they were
      clearTimeout(this.stateTimeout)
      this.stateTimeout = undefined
      this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(prevState))
      this.platform.deviceUpdateError(this.accessory, err, true)
      setTimeout(() => {
        this.service.updateCharacteristic(
          this.hapChar.TargetDoorState,
          this.invPos(prevState === 4 ? 1 : prevState % 2),
        )
      }, 2000)
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, new this.hapErr(-70402))
    }
  }

  // Show the door moving towards open (0) or closed (1), and settle on it after
  // the operation time. A movement that is already under way to the same
  // position keeps its timer (e.g. the device confirming our own command), while
  // a different one replaces it. There is no open limit, so an opening always
  // ends as open: the doorState report that the gate has left its closed limit
  // can arrive after the operation time, and showing a moving gate as closed is
  // the one mistake that must not happen.
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

  // With doorState, closing lasts until the gate reports its closed limit. If
  // that has not happened after twice the closing time, the gate is shown as
  // open: whatever is not confirmed closed is open, even if only part way.
  startClosing() {
    const current = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)
    if (current === 3 && this.stateTimeout) {
      return
    }
    clearTimeout(this.stateTimeout)
    this.service.updateCharacteristic(this.hapChar.TargetDoorState, this.invPos(1))
    this.service.updateCharacteristic(this.hapChar.CurrentDoorState, this.invPos(3))
    this.stateTimeout = setTimeout(() => {
      this.stateTimeout = undefined
      if (this.lastDoorState !== 0) {
        this.applySwitchState(0, true)
      }
    }, this.operationTimeDown * 2 * 100)
  }

  // Work out the door from the last order (switch) and, if the device reports
  // it, the closed limit (doorState). With the closed limit, only that limit
  // makes the gate closed; anything else is open, even if only part way. isLive
  // is false for the state read at startup, which is shown as it is rather than
  // as a movement. switchChanged is true when this report carries a new order,
  // and doorStateReported when it carries the closed limit.
  followDevice(isLive, switchChanged, doorStateReported = true) {
    const sw = this.lastSwitch
    const current = this.invPos(this.service.getCharacteristic(this.hapChar.CurrentDoorState).value)

    if (!this.hasDoorState) {
      if (!sw) {
        return
      }
      const newPos = sw === 'on' ? 0 : 1
      if (isLive) {
        this.startTravel(newPos)
      } else if (current !== newPos) {
        this.applySwitchState(newPos, false)
      }
      return
    }

    if (!isLive) {
      // At startup: on the closed limit is closed, anything else is open
      const newPos = this.lastDoorState === 0 ? 1 : 0
      if (current !== newPos) {
        this.applySwitchState(newPos, false)
      }
      return
    }

    // A new order: opening for the operation time, or closing until the
    // closed limit confirms it
    if (switchChanged && sw === 'on') {
      this.startTravel(0)
      return
    }
    if (switchChanged && sw === 'off') {
      if (doorStateReported && this.lastDoorState === 0) {
        this.applySwitchState(1, true)
      } else {
        this.startClosing()
      }
      return
    }

    // No new order: only the closed limit says anything. On it is closed (an
    // open order that has not yet taken the gate off it keeps opening); off it
    // is open, so a gate shown closed is opening (e.g. opened by hand, or the
    // report came late). A report with only the switch carries an old closed
    // limit and changes nothing.
    if (!doorStateReported) {
      return
    }
    if (this.lastDoorState === 0) {
      if (current === 2 && this.stateTimeout) {
        return
      }
      if (current !== 1) {
        this.applySwitchState(1, true)
      }
      return
    }
    if (current === 1) {
      this.startTravel(0)
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
        const hasSwitch = params.switch === 'on' || params.switch === 'off'
        const doorState = Number(params.doorState)
        const hasDoorState = hasProperty(params, 'doorState') && [0, 1].includes(doorState)
        if (!hasSwitch && !hasDoorState) {
          return
        }
        const switchChanged = hasSwitch && this.lastSwitch !== undefined && params.switch !== this.lastSwitch
        if (hasSwitch) {
          this.lastSwitch = params.switch
        }
        if (hasDoorState) {
          this.lastDoorState = doorState
          this.hasDoorState = true
        }
        this.followDevice(!!params.updateSource, switchChanged, hasDoorState)
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

  destroy() {
    clearInterval(this.intervalPoll)
    clearTimeout(this.stateTimeout)
  }

  markStatus(isOnline) {
    this.isOnline = isOnline
  }
}
