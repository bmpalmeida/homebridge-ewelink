import { afterEach, describe, expect, it, vi } from 'vitest'

import deviceTypes from '../lib/device/index.js'
import { buildHandler } from './build-handlers.js'
import { payloads } from './payloads.js'

/**
 * What a handler does with a message a real device actually sent.
 *
 * The snapshot next door records what each handler builds. This records what it
 * then does with what arrives, which is where the interesting mistakes live -
 * two devices on the same handler reporting the same reading in different
 * units, for instance.
 */

function feed(name, Handler, params, context = {}) {
  const built = buildHandler(name, Handler, {}, context)
  expect(built.error).toBeUndefined()
  return built
}

describe('the zigbee ambient sensor, on payloads from real devices', () => {
  const Handler = deviceTypes.zb.deviceSensorAmbient
  const name = 'zb.deviceSensorAmbient'

  it('reads hundredths of a degree from an AirGuard TH (#767)', async () => {
    const { device, accessory } = feed(name, Handler, payloads.airGuardTH.params)

    await device.externalUpdate(payloads.airGuardTH.params)

    // 2620 is 26.20 degrees
    expect(accessory.getService('TemperatureSensor')
      .getCharacteristic('CurrentTemperature').value).toBe(26.2)
  })

  it('reads degrees from an SNZB-02LD, which reports them with a decimal point (#701)', async () => {
    const { device, accessory } = feed(name, Handler, payloads.snzb02ld.params)

    await device.externalUpdate(payloads.snzb02ld.params)

    // "18.4" is already the temperature. Read as hundredths it became 0.18,
    // which is what an owner saw in HomeKit before this was pinned down.
    expect(accessory.getService('TemperatureSensor')
      .getCharacteristic('CurrentTemperature').value).toBe(18.4)
  })

  it('reads hundredths of a percent for humidity (#767)', async () => {
    const { device, accessory } = feed(name, Handler, payloads.airGuardTH.params)

    await device.externalUpdate(payloads.airGuardTH.params)

    // 4390 is 43.90 percent, cut to a whole number because that is all HomeKit
    // shows. Recorded as it stands: the value is truncated, not rounded.
    expect(accessory.getService('HumiditySensor')
      .getCharacteristic('CurrentRelativeHumidity').value).toBe(43)
  })

  it('carries the battery level across, and flags a low one', async () => {
    const { device, accessory } = feed(name, Handler, payloads.snzb02ld.params)

    await device.externalUpdate(payloads.snzb02ld.params)
    expect(accessory.getService('Battery').getCharacteristic('BatteryLevel').value).toBe(100)
    expect(accessory.getService('Battery').getCharacteristic('StatusLowBattery').value).toBe(0)

    await device.externalUpdate({ ...payloads.snzb02ld.params, battery: 5 })
    expect(accessory.getService('Battery').getCharacteristic('StatusLowBattery').value).toBe(1)
  })

  it('ignores a reading it cannot make sense of, rather than showing a wrong one', async () => {
    const { device, accessory } = feed(name, Handler, payloads.airGuardTH.params)

    await device.externalUpdate(payloads.airGuardTH.params)
    const good = accessory.getService('TemperatureSensor')
      .getCharacteristic('CurrentTemperature')
      .value

    await device.externalUpdate({ ...payloads.airGuardTH.params, temperature: 'not-a-number' })

    expect(accessory.getService('TemperatureSensor')
      .getCharacteristic('CurrentTemperature').value).toBe(good)
  })
})

describe('a power-reporting outlet, on payloads from a real device', () => {
  const Handler = deviceTypes.deviceOutletSingle
  const name = 'deviceOutletSingle'

  it('follows the switch state out of a multi-channel frame (#742)', async () => {
    // One outlet, but firmware that still reports a switches array. The handler
    // only reads that array for the UIIDs listed as multi-channel, so the test
    // has to build one of those - on any other UIID the frame is ignored, which
    // is what "not responding to state updates" looks like from outside.
    const { device, accessory } = feed(name, Handler, payloads.s60tpfOn.params, {
      eweUIID: payloads.s60tpfOn.uiid,
    })

    await device.externalUpdate(payloads.s60tpfOn.params)
    expect(accessory.getService('Outlet').getCharacteristic('On').value).toBe(true)

    await device.externalUpdate(payloads.s60tpfOff.params)
    expect(accessory.getService('Outlet').getCharacteristic('On').value).toBe(false)
  })
})

describe('a gate controller shown as a garage, whose switch is the last order (#760)', () => {
  const Handler = deviceTypes.sim.deviceGarageOne
  const name = 'sim.deviceGarageOne'

  // The electric gate controller (uiid 216) turns its switch on with an open
  // order and off with a close order, as soon as the order is given. It also
  // sends doorState, 0 on its closed limit and 1 off it. Sampled from a real
  // gate over a full cycle: on/1 when opening, off/1 when the close order is
  // given, off/0 about 16 s later once actually closed.
  const opening = { switch: 'on', doorState: 1, updateSource: 'WS' }
  const closing = { switch: 'off', doorState: 1, updateSource: 'WS' }
  const closed = { switch: 'off', doorState: 0, updateSource: 'WS' }

  // A device that only reports its switch
  const on = { switch: 'on', updateSource: 'WS' }
  const off = { switch: 'off', updateSource: 'WS' }

  function gate(settings) {
    const built = buildHandler(name, Handler, {
      deviceConf: { '10001abcde': { showAs: 'garage', switchIsState: true, operationTime: 150, ...settings } },
    }, { eweUIID: 216 })
    expect(built.error).toBeUndefined()
    return built
  }

  const state = (accessory, char) => accessory.getService('GarageDoorOpener')
    .getCharacteristic(char)
    .value

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('with only the switch reported', () => {
    it('takes the state read at startup as it is, without a movement', async () => {
      const { device, accessory } = gate({})

      await device.externalUpdate({ switch: 'on' })
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      expect(state(accessory, 'TargetDoorState')).toBe(0)

      await device.externalUpdate({ switch: 'off' })
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
    })

    it('follows the switch both ways, moving for the operation time, including a change made outside HomeKit', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({ operationTimeDown: 200 })
      await device.externalUpdate({ switch: 'off' })

      await device.externalUpdate(on)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      expect(state(accessory, 'TargetDoorState')).toBe(0)
      vi.advanceTimersByTime(14900)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(100)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(5000)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('turns the switch on to open and off to close, and settles after the operation time', async () => {
      vi.useFakeTimers()
      const { device, accessory, platform } = gate({})
      await device.externalUpdate({ switch: 'off' })

      await device.internalUpdate(0)
      expect(platform.sent.at(-1).params).toEqual({ switch: 'on' })
      expect(state(accessory, 'CurrentDoorState')).toBe(2)

      // The device confirming the command does not restart the movement
      vi.advanceTimersByTime(5000)
      await device.externalUpdate(on)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(10000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      await device.internalUpdate(1)
      expect(platform.sent.at(-1).params).toEqual({ switch: 'off' })
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      device.destroy()
    })

    it('settles on the commanded switch if the device never reports back', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off' })

      await device.internalUpdate(0)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('turns round when a new report arrives mid-travel', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off' })

      await device.externalUpdate(on)
      vi.advanceTimersByTime(8000)

      // Closed again from the remote before the gate finished opening: the
      // opening timer is dropped and the closing one runs in full
      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
      vi.advanceTimersByTime(8000)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(7000)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })
  })

  describe('with the closed limit (doorState) reported', () => {
    // The cloud's last report, as getDeviceParams returns it
    function withCloud(platform, cloud) {
      const http = []
      platform.httpClient = {
        getDeviceParams: async () => ({ ...cloud.params }),
        updateDevice: async (id, params) => http.push(params),
      }
      return http
    }

    it('shows closed when the cloud says closed with the switch on (19/10)', async () => {
      const { device, accessory, platform } = gate({})
      withCloud(platform, { params: { switch: 'on', doorState: 0 } })
      // shown open (cached), but the gate is on its closed limit
      accessory.getService('GarageDoorOpener').updateCharacteristic('CurrentDoorState', 0)
      accessory.getService('GarageDoorOpener').updateCharacteristic('TargetDoorState', 0)
      await device.readCloud()
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
      device.destroy()
    })

    it('shows every doorState report at once, current and target alike, with no timers', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)

      await device.externalUpdate(opening)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      expect(state(accessory, 'TargetDoorState')).toBe(0)

      await device.externalUpdate(closing)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      vi.advanceTimersByTime(600000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      await device.externalUpdate(closed)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)

      // the limit alone, the gate opened by hand
      await device.externalUpdate({ doorState: 1, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      // a report with only the switch changes nothing
      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('a cloud read changes the shown state at once', async () => {
      const { device, accessory, platform } = gate({})
      const cloud = { params: { switch: 'off', doorState: 0 } }
      withCloud(platform, cloud)
      await device.readCloud()
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      cloud.params = { switch: 'on', doorState: 1 }
      await device.readCloud()
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      expect(state(accessory, 'TargetDoorState')).toBe(0)
      device.destroy()
    })

    it('opens a closed gate whose last order is on: off, then on (19/10)', async () => {
      const { device, platform } = gate({})
      withCloud(platform, { params: { switch: 'on', doorState: 0 } })
      device.orderGapMs = 0
      await device.internalUpdate(0)
      expect(platform.sent.map(x => x.params)).toEqual([{ switch: 'off' }, { switch: 'on' }])
      // the echo of the off is not taken as the last order
      await device.externalUpdate({ switch: 'off', updateSource: 'WS' })
      expect(device.lastSwitch).toBe('on')
      device.destroy()
    })

    it('opens a closed gate whose last order is off: on', async () => {
      const { device, platform } = gate({})
      withCloud(platform, { params: { switch: 'off', doorState: 0 } })
      await device.internalUpdate(0)
      expect(platform.sent.map(x => x.params)).toEqual([{ switch: 'on' }])
      device.destroy()
    })

    it('closes an open gate: off, or on then off when the last order is already off', async () => {
      const a = gate({})
      withCloud(a.platform, { params: { switch: 'on', doorState: 1 } })
      await a.device.internalUpdate(1)
      expect(a.platform.sent.map(x => x.params)).toEqual([{ switch: 'off' }])
      a.device.destroy()

      const b = gate({})
      withCloud(b.platform, { params: { switch: 'off', doorState: 1 } })
      b.device.orderGapMs = 0
      await b.device.internalUpdate(1)
      expect(b.platform.sent.map(x => x.params)).toEqual([{ switch: 'on' }, { switch: 'off' }])
      b.device.destroy()
    })

    it('sends nothing when the gate is already there, and shows it as it is', async () => {
      vi.useFakeTimers()
      const { device, accessory, platform } = gate({})
      withCloud(platform, { params: { switch: 'on', doorState: 1 } })
      await device.internalUpdate(0)
      expect(platform.sent).toEqual([])

      withCloud(platform, { params: { switch: 'on', doorState: 0 } })
      // shown open (wrongly), the user asks to close: it is closed, so nothing is sent
      accessory.getService('GarageDoorOpener').updateCharacteristic('CurrentDoorState', 0)
      accessory.getService('GarageDoorOpener').updateCharacteristic('TargetDoorState', 1)
      await device.internalUpdate(1)
      expect(platform.sent).toEqual([])
      vi.advanceTimersByTime(0)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
      device.destroy()
    })

    it('uses the last known doorState when the cloud read fails', async () => {
      const { device, platform } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })
      platform.httpClient = {
        getDeviceParams: async () => {
          throw new Error('timeout')
        },
        updateDevice: async () => {},
      }
      await device.internalUpdate(0)
      expect(platform.sent.map(x => x.params)).toEqual([{ switch: 'on' }])
      device.destroy()
    })

    it('orders through http when the web socket fails (16/10)', async () => {
      const { device, platform } = gate({})
      const http = withCloud(platform, { params: { switch: 'on', doorState: 0 } })
      platform.sendDeviceUpdate = async () => {
        throw new Error('request timeout [504]')
      }
      device.orderGapMs = 0
      await device.internalUpdate(0)
      expect(http).toEqual([{ switch: 'off' }, { switch: 'on' }])
      device.destroy()
    })

    it('reads the cloud every 30 s for 2 minutes after an order, else every 2 minutes', async () => {
      vi.useFakeTimers()
      const { device, platform } = gate({})
      let reads = 0
      platform.httpClient = {
        getDeviceParams: async () => {
          reads += 1
          return { switch: 'off', doorState: 0 }
        },
        updateDevice: async () => {},
      }
      device.intervalCloud = setInterval(() => device.cloudTick(), 30000)
      device.lastCloudReadAt = Date.now()
      await vi.advanceTimersByTimeAsync(90000)
      expect(reads).toBe(0)
      await vi.advanceTimersByTimeAsync(30000)
      expect(reads).toBe(1)

      await device.internalUpdate(0) // one read before the order
      expect(reads).toBe(2)
      // the ticks 30, 60 and 90 s after the order read; 120 s after it is the
      // slow pace again, and the last read was only 30 s before
      await vi.advanceTimersByTimeAsync(120000)
      expect(reads).toBe(5)
      device.destroy()
    })
  })

  it('keeps the momentary behaviour when the option is off', async () => {
    const { device, accessory, platform } = gate({ switchIsState: false })

    // A switch reported off is not a pulse, so it is ignored as before
    await device.externalUpdate(closed)
    expect(state(accessory, 'CurrentDoorState')).toBe(1)

    // Opening still sends a pulse and then waits out the operation time, so
    // this only looks at the command rather than waiting for the result
    device.internalUpdate(0)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(platform.sent.at(-1).params).toEqual({ switch: 'on' })
    expect(state(accessory, 'CurrentDoorState')).toBe(2)
  })
})
