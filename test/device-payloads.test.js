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
    it('stays open when the closed limit report after an open order is the old one (16/10)', async () => {
      // A real morning: open order at 07:39:46, the controller kept reporting
      // its closed limit until 07:40:11 (25 s later), and HomeKit showed the
      // gate closed while it opened
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate(closed)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      await device.externalUpdate({ switch: 'on', doorState: 0, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(15000)
      await device.externalUpdate({ switch: 'on', doorState: 0, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      vi.advanceTimersByTime(10000)
      await device.externalUpdate({ doorState: 0, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      await device.externalUpdate(opening)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      // later, a fresh closed limit (it closed by itself): closed
      await device.externalUpdate({ switch: 'on', doorState: 0, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('is closed again if an open order never takes the gate off its closed limit', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate(closed)
      await device.externalUpdate({ switch: 'on', doorState: 0, updateSource: 'WS' })
      vi.advanceTimersByTime(60000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
      vi.advanceTimersByTime(60000)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('reads the state at startup: closed on the closed limit, open otherwise', async () => {
      const shut = gate({})
      await shut.device.externalUpdate({ switch: 'off', doorState: 0 })
      expect(state(shut.accessory, 'CurrentDoorState')).toBe(1)
      expect(state(shut.accessory, 'TargetDoorState')).toBe(1)

      const wide = gate({})
      await wide.device.externalUpdate({ switch: 'on', doorState: 1 })
      expect(state(wide.accessory, 'CurrentDoorState')).toBe(0)
      expect(state(wide.accessory, 'TargetDoorState')).toBe(0)

      // Off the closed limit after a close order: not closed, so open
      const between = gate({})
      await between.device.externalUpdate({ switch: 'off', doorState: 1 })
      expect(state(between.accessory, 'CurrentDoorState')).toBe(0)
      expect(state(between.accessory, 'TargetDoorState')).toBe(0)
    })

    it('opens for the operation time, then stays closing until the closed limit confirms it (the real cycle)', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })

      // 21:26:03 open order
      await device.externalUpdate(opening)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      expect(state(accessory, 'TargetDoorState')).toBe(0)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      // 21:26:20 close order, the gate still open
      vi.advanceTimersByTime(2000)
      await device.externalUpdate(closing)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      expect(state(accessory, 'TargetDoorState')).toBe(1)

      // Repeated reports while it moves change nothing, and the operation time
      // alone does not close it
      vi.advanceTimersByTime(15000)
      await device.externalUpdate(closing)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)

      // 21:26:36 the closed limit
      vi.advanceTimersByTime(1000)
      await device.externalUpdate(closed)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)

      // No timer left to undo it
      vi.advanceTimersByTime(60000)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('shows open if the closed limit never comes, and closed once it does', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({ operationTimeDown: 200 })
      await device.externalUpdate({ switch: 'on', doorState: 1 })

      await device.externalUpdate(closing)
      vi.advanceTimersByTime(39900)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(100)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      // A repeated report does not start a new closing
      await device.externalUpdate(closing)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      await device.externalUpdate(closed)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('closes from HomeKit and waits for the closed limit', async () => {
      vi.useFakeTimers()
      const { device, accessory, platform } = gate({})
      await device.externalUpdate({ switch: 'on', doorState: 1 })

      await device.internalUpdate(1)
      expect(platform.sent.at(-1).params).toEqual({ switch: 'off' })
      expect(state(accessory, 'CurrentDoorState')).toBe(3)

      await device.externalUpdate(closing)
      vi.advanceTimersByTime(20000)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)

      await device.externalUpdate(closed)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('turns round when a new order arrives mid-travel', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })

      // Close order while opening: closing, and only the limit closes it
      await device.externalUpdate(opening)
      vi.advanceTimersByTime(8000)
      await device.externalUpdate(closing)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)

      // Open order while closing: opening, and open after the full opening time
      await device.externalUpdate(opening)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      expect(state(accessory, 'TargetDoorState')).toBe(0)
      vi.advanceTimersByTime(14900)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(100)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('keeps the last value of each key when a report carries only one', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })

      // The open order alone, the gate still on its limit: opening
      await device.externalUpdate(on)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)

      // Then the limit alone, the gate leaving it: still opening, same timer
      vi.advanceTimersByTime(3000)
      await device.externalUpdate({ doorState: 1, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(12000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      // The close order alone, the last doorState still 1: closing
      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)

      // The limit alone, with the last switch off: closed
      await device.externalUpdate({ doorState: 0, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
    })

    it('ends an opening as open even if the closed limit report comes late (13/10)', async () => {
      // 13/10 08:16:57: opened from HomeKit; the report that the gate had left its
      // closed limit came after the 15 s opening time, and the gate was shown
      // closed while it was open
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })

      await device.internalUpdate(0)
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      // A late report with only the switch does not bring back the old limit
      await device.externalUpdate({ switch: 'on', updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('never stays closing when the closed limit is not reported again (13/10)', async () => {
      // 13/10 16:51: opened, shown open; when the gate closed only the switch was
      // reported, the last closed limit already being 0, and it stayed closing
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })
      await device.externalUpdate(on)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)

      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(29900)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(100)
      expect(state(accessory, 'CurrentDoorState')).toBe(1)
      expect(state(accessory, 'TargetDoorState')).toBe(1)
    })

    it('ends a closing that never reaches the closed limit as open', async () => {
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'on', doorState: 1 })
      await device.externalUpdate(off)
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
      vi.advanceTimersByTime(30000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('shows a gate that leaves its closed limit without an order as opening, then open', async () => {
      // e.g. opened by hand, or the open order's report lost
      vi.useFakeTimers()
      const { device, accessory } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })
      await device.externalUpdate({ doorState: 1, updateSource: 'WS' })
      expect(state(accessory, 'CurrentDoorState')).toBe(2)
      vi.advanceTimersByTime(15000)
      expect(state(accessory, 'CurrentDoorState')).toBe(0)
    })

    it('always sends a close when the gate is off its closed limit, even if shown closed (13/10)', async () => {
      vi.useFakeTimers()
      const { device, accessory, platform } = gate({})
      await device.externalUpdate({ switch: 'off', doorState: 0 })
      await device.externalUpdate({ doorState: 1 }) // off the limit, shown wrongly
      accessory.getService('GarageDoorOpener').updateCharacteristic('CurrentDoorState', 1)
      const before = platform.sent.length
      device.orderGapMs = 0

      await device.internalUpdate(1)
      // its last order was already off, so it only moves after an on then an off (16/10)
      expect(platform.sent.slice(before).map(x => x.params)).toEqual([{ switch: 'on' }, { switch: 'off' }])
      expect(state(accessory, 'CurrentDoorState')).toBe(3)
    })

    it('sends the opposite order first when the last order is already the wanted one (16/10)', async () => {
      const { device, accessory, platform } = gate({})
      // the gate was opened (on) and later closed by its remote: the switch stays on
      await device.externalUpdate({ switch: 'on', doorState: 0 })
      accessory.getService('GarageDoorOpener').updateCharacteristic('CurrentDoorState', 1)
      const before = platform.sent.length
      device.orderGapMs = 0

      await device.internalUpdate(0)
      expect(platform.sent.slice(before).map(x => x.params)).toEqual([{ switch: 'off' }, { switch: 'on' }])
      // the echo of the off is not taken as a close
      await device.externalUpdate({ switch: 'off', updateSource: 'WS' })
      expect(state(accessory, 'TargetDoorState')).toBe(0)
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
