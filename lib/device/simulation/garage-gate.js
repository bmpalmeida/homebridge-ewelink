import platformConsts from '../../utils/constants.js'
import { hasProperty, sleep } from '../../utils/functions.js'

// HomeKit door states
const OPEN = 0
const CLOSED = 1
const OPENING = 2
const CLOSING = 3

/**
 * An electric gate controller (e.g. uiid 216, CK-BL602-TC-01) shown as a garage
 * door, selected with showAs garage + switchIsState (#760).
 *
 * What the controller does, sampled from a real gate:
 *  - switch is the last order given through eWeLink: 'on' opens, 'off' closes.
 *    It only acts when the order CHANGES: sending 'on' while it is already 'on'
 *    does nothing, even if the gate was closed since by its own remote.
 *  - doorState is the closed limit: 0 on it, 1 off it. It is the only report of
 *    where the gate really is. There is no open limit and no stop.
 *  - It can be slow or out of reach of the cloud: an order may time out on the
 *    web socket (504) or be refused by the cloud (4002) and work a moment later.
 *
 * So this handler:
 *  - shows closed only on the closed limit, and open otherwise;
 *  - shows a movement for the operation time after any order, ours or not;
 *  - always sends the opposite order first and then the wanted one, so the
 *    wanted one is always a change, whatever the last order was;
 *  - sends each order through the web socket, then through the cloud's http
 *    api, and tries again a few times before giving up;
 *  - reads the controller's last report from the cloud regularly, as the web
 *    socket does not always deliver it.
 */
export default class {
  constructor(platform, accessory) {
    this.eveChar = platform.eveChar
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform
    this.name = accessory.displayName
    this.accessory = accessory
    this.isOnline = true

    const deviceConf = platform.deviceConf[accessory.context.eweDeviceId] || {}
    this.operationTimeUp = deviceConf.operationTime || platformConsts.defaultValues.operationTime
    this.operationTimeDown = deviceConf.operationTimeDown || this.operationTimeUp
    this.orderGapMs = 1000
    this.orderAttempts = 3
    this.retryGapMs = 3000
    this.cloudReadMs = 60000

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

    ;[this.hapServ.Switch, this.hapServ.ContactSensor].forEach((type) => {
      const old = this.accessory.getService(type)
      if (old) {
        this.accessory.removeService(old)
      }
    })
    this.service = this.accessory.getService(this.hapServ.GarageDoorOpener)
    if (!this.service) {
      this.service = this.accessory.addService(this.hapServ.GarageDoorOpener)
      this.service.updateCharacteristic(this.hapChar.CurrentDoorState, CLOSED)
      this.service.updateCharacteristic(this.hapChar.TargetDoorState, CLOSED)
      this.service.updateCharacteristic(this.hapChar.ObstructionDetected, false)
      this.service.addCharacteristic(this.eveChar.LastActivation)
      this.service.addCharacteristic(this.eveChar.ResetTotal)
      this.service.addCharacteristic(this.eveChar.TimesOpened)
    }
    this.service.getCharacteristic(this.eveChar.ResetTotal).onSet(() => {
      this.service.updateCharacteristic(this.eveChar.TimesOpened, 0)
    })
    this.service.getCharacteristic(this.hapChar.TargetDoorState).onSet((value) => {
      // Not awaited: HomeKit gets its answer straight away
      this.internalUpdate(value)
    })
    if (!platform.config.disableNoResponse) {
      ;[this.hapChar.CurrentDoorState, this.hapChar.TargetDoorState].forEach((char) => {
        this.service.getCharacteristic(char).onGet(() => {
          if (!this.isOnline) {
            throw new this.hapErr(-70402)
          }
          return this.service.getCharacteristic(char).value
        })
      })
    }

    this.accessory.eveService = new platform.eveService('door', this.accessory, { log: () => {} })
    this.accessory.eveService.addEntry({ status: this.current() === OPEN ? 0 : 1 })

    // The last switch and doorState the controller reported (undefined until the first report)
    this.lastSwitch = undefined
    this.lastDoorState = undefined

    if (platform.httpClient) {
      this.cloudTimeout = setTimeout(() => this.readCloud(), 5000)
      this.intervalCloud = setInterval(() => this.readCloud(), this.cloudReadMs)
    }

    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, JSON.stringify({
      logging: this.enableDebugLogging ? 'debug' : (this.enableLogging ? 'standard' : 'disable'),
      operationTimeDown: this.operationTimeDown,
      operationTimeUp: this.operationTimeUp,
      showAs: 'garage',
      switchIsState: true,
    }))
  }

  current() {
    return this.service.getCharacteristic(this.hapChar.CurrentDoorState).value
  }

  // Where the gate is when not moving: closed only on its closed limit
  restingState() {
    if (this.lastDoorState !== undefined) {
      return this.lastDoorState === 0 ? CLOSED : OPEN
    }
    return this.lastSwitch === 'on' ? OPEN : CLOSED
  }

  show(state, target) {
    this.service.updateCharacteristic(this.hapChar.TargetDoorState, target ?? (state % 2))
    this.service.updateCharacteristic(this.hapChar.CurrentDoorState, state)
  }

  // Show a movement for the operation time, then where the gate is
  startMovement(toOpen) {
    clearTimeout(this.moveTimeout)
    this.moving = toOpen ? OPENING : CLOSING
    this.show(this.moving, toOpen ? OPEN : CLOSED)
    if (toOpen) {
      this.countOpening()
    }
    const ms = (toOpen ? this.operationTimeUp : this.operationTimeDown) * 100
    this.moveTimeout = setTimeout(() => this.endMovement(), ms)
  }

  endMovement() {
    clearTimeout(this.moveTimeout)
    this.moveTimeout = undefined
    this.moving = undefined
    const state = this.restingState()
    this.show(state)
    if (state === CLOSED) {
      this.accessory.eveService.addEntry({ status: 1 })
    }
    if (this.enableLogging) {
      this.log('[%s] %s [%s].', this.name, this.lang.curState, state === OPEN ? this.lang.doorOpen : this.lang.doorClosed)
    }
  }

  countOpening() {
    this.accessory.eveService.addEntry({ status: 0 })
    const initialTime = this.accessory.eveService.getInitialTime()
    this.service.updateCharacteristic(this.eveChar.LastActivation, Math.round(Date.now() / 1000) - initialTime)
    this.service.updateCharacteristic(
      this.eveChar.TimesOpened,
      this.service.getCharacteristic(this.eveChar.TimesOpened).value + 1,
    )
  }

  // One order, through the web socket and then the http api, a few times
  async sendOrder(target) {
    let lastErr
    for (let attempt = 1; attempt <= this.orderAttempts; attempt += 1) {
      try {
        await this.platform.sendDeviceUpdate(this.accessory, { switch: target })
        return
      } catch (err) {
        lastErr = err
      }
      if (this.platform.httpClient) {
        try {
          await this.platform.httpClient.updateDevice(this.accessory.context.eweDeviceId, { switch: target })
          return
        } catch (err) {
          lastErr = err
        }
      }
      if (this.enableLogging) {
        this.log.warn('[%s] order [%s] attempt %s of %s failed: %s', this.name, target, attempt, this.orderAttempts, String(lastErr?.message || lastErr).replace(/\s+/g, ' '))
      }
      if (attempt < this.orderAttempts) {
        await sleep(this.retryGapMs)
      }
    }
    throw lastErr
  }

  async internalUpdate(value) {
    const toOpen = value === OPEN
    const wanted = toOpen ? 'on' : 'off'
    this.ordering = true
    this.startMovement(toOpen)
    try {
      // The opposite order first: if the last order was already the wanted one,
      // the controller would ignore it. The gate is not there (or HomeKit would
      // not ask), and an order towards where it already is does nothing
      await this.sendOrder(toOpen ? 'off' : 'on')
      await sleep(this.orderGapMs)
      await this.sendOrder(wanted)
      this.lastSwitch = wanted
      this.orderedAt = Date.now()
      if (toOpen) {
        // The controller leaves its closed limit as it starts: until it says so,
        // a stored closed report is old
        this.lastDoorState = 1
      }
    } catch (err) {
      // The order never got through: the gate is where it was
      this.platform.deviceUpdateError(this.accessory, err, true)
      this.endMovement()
    } finally {
      this.ordering = false
    }
  }

  async externalUpdate(params) {
    try {
      const hasSwitch = hasProperty(params, 'switch')
      const hasDoor = hasProperty(params, 'doorState')
      if (!hasSwitch && !hasDoor) {
        return
      }
      const first = this.lastSwitch === undefined && this.lastDoorState === undefined
      const switchChanged = hasSwitch && this.lastSwitch !== undefined && params.switch !== this.lastSwitch
      const door = hasDoor ? Number(params.doorState) : undefined
      const doorChanged = hasDoor && this.lastDoorState !== undefined && door !== this.lastDoorState
      if (hasSwitch) {
        this.lastSwitch = params.switch
      }
      if (hasDoor) {
        this.lastDoorState = door
      }
      if (this.ordering) {
        // Our own orders echoing back: the movement is already shown
        return
      }
      if (first) {
        // What the controller says at startup is where the gate is
        this.show(this.restingState())
        return
      }
      if (door === 0 && this.moving === OPENING && Date.now() - (this.orderedAt || 0) < 5000) {
        // A report from before our open order: the controller leaves the closed
        // limit about a second after the order
        this.lastDoorState = 1
        return
      }
      if (door === 0) {
        // On the closed limit: closed now, whatever was shown
        if (this.current() !== CLOSED || this.moving) {
          this.endMovement()
        }
        return
      }
      if (switchChanged) {
        // An order given elsewhere (the eWeLink app, another integration)
        this.startMovement(params.switch === 'on')
        return
      }
      if (doorChanged && door === 1 && !this.moving) {
        // Off the closed limit without an eWeLink order: opened by its remote
        this.startMovement(true)
        return
      }
      if (!this.moving && this.current() !== this.restingState()) {
        this.show(this.restingState())
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, false)
    }
  }

  // The controller's last report, from the cloud
  async readCloud() {
    if (this.moving || this.ordering || !this.platform.httpClient?.getDeviceParams) {
      return
    }
    try {
      const params = await this.platform.httpClient.getDeviceParams(this.accessory.context.eweDeviceId)
      if (params) {
        const read = {}
        if (hasProperty(params, 'switch')) {
          read.switch = params.switch
        }
        if (hasProperty(params, 'doorState')) {
          read.doorState = params.doorState
        }
        await this.externalUpdate(read)
      }
    } catch (err) {
      if (this.enableDebugLogging) {
        this.log('[%s] cloud read failed: %s', this.name, String(err?.message || err).replace(/\s+/g, ' '))
      }
    }
  }

  destroy() {
    clearInterval(this.intervalCloud)
    clearTimeout(this.cloudTimeout)
    clearTimeout(this.moveTimeout)
  }

  markStatus(isOnline) {
    this.isOnline = isOnline
  }
}
