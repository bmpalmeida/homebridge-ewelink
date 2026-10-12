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

describe('a gate controller shown as a garage, whose switch is the door state (#760)', () => {
  const Handler = deviceTypes.sim.deviceGarageOne
  const name = 'sim.deviceGarageOne'

  // The electric gate controller (uiid 216) keeps its switch on while the gate
  // is open and turns it off once closed. It also sends doorState, 0 when
  // closed, whose other values are not known, so the handler ignores it.
  const closed = { switch: 'off', doorState: 0, updateSource: 'WS' }
  const open = { switch: 'on', updateSource: 'WS' }

  function gate(settings) {
    const built = buildHandler(name, Handler, {
      deviceConf: { '10001abcde': { showAs: 'garage', ...settings } },
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

  it('follows the switch both ways, including a change made outside HomeKit', async () => {
    const { device, accessory } = gate({ switchIsState: true })

    await device.externalUpdate(open)
    expect(state(accessory, 'CurrentDoorState')).toBe(0)
    expect(state(accessory, 'TargetDoorState')).toBe(0)

    await device.externalUpdate(closed)
    expect(state(accessory, 'CurrentDoorState')).toBe(1)
    expect(state(accessory, 'TargetDoorState')).toBe(1)
  })

  it('turns the switch on to open and off to close, and shows the move until the device reports', async () => {
    const { device, accessory, platform } = gate({ switchIsState: true })
    await device.externalUpdate(closed)

    await device.internalUpdate(0)
    expect(platform.sent.at(-1).params).toEqual({ switch: 'on' })
    expect(state(accessory, 'CurrentDoorState')).toBe(2)

    await device.externalUpdate(open)
    expect(state(accessory, 'CurrentDoorState')).toBe(0)

    await device.internalUpdate(1)
    expect(platform.sent.at(-1).params).toEqual({ switch: 'off' })
    expect(state(accessory, 'CurrentDoorState')).toBe(3)
    device.destroy()
  })

  it('settles on the commanded switch if the device never reports back', async () => {
    vi.useFakeTimers()
    const { device, accessory } = gate({ switchIsState: true, operationTime: 150 })
    await device.externalUpdate(closed)

    await device.internalUpdate(0)
    expect(state(accessory, 'CurrentDoorState')).toBe(2)
    vi.advanceTimersByTime(15000)
    expect(state(accessory, 'CurrentDoorState')).toBe(0)
  })

  it('keeps the momentary behaviour when the option is off', async () => {
    const { device, accessory, platform } = gate({})

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
