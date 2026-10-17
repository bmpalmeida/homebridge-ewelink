import { afterEach, describe, expect, it, vi } from 'vitest'

import deviceTypes from '../lib/device/index.js'
import { buildHandler } from './build-handlers.js'

// An electric gate controller (uiid 216) shown as a garage with switchIsState
// (#760). switch is the last order (on opens, off closes) and the controller
// only acts when it changes; doorState is the closed limit (0 on it, 1 off it).
const OPEN = 0
const CLOSED = 1
const OPENING = 2
const CLOSING = 3

function gate({ http, failWs = 0 } = {}) {
  let wsFails = failWs
  const overrides = {
    deviceConf: { '10001abcde': { showAs: 'garage', switchIsState: true, operationTime: 150 } },
  }
  const built = buildHandler('sim.deviceGarageGate', deviceTypes.sim.deviceGarageGate, overrides, { eweUIID: 216 })
  expect(built.error).toBeUndefined()
  const { platform } = built
  const ws = platform.sendDeviceUpdate
  platform.sendDeviceUpdate = async (accessory, params) => {
    if (wsFails > 0) {
      wsFails -= 1
      throw new Error('request timeout [504]')
    }
    return ws(accessory, params)
  }
  if (http) {
    platform.httpClient = http
  }
  return built
}

function state(accessory, char = 'CurrentDoorState') {
  return accessory.getService('GarageDoorOpener')
    .getCharacteristic(char)
    .value
}

// Let the order's awaits and timers run
async function run(ms) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('an electric gate controller shown as a garage (#760)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes the first report as where the gate is, closed only on the closed limit', async () => {
    const { device, accessory } = gate()
    await device.externalUpdate({ switch: 'on', doorState: 0 })
    expect(state(accessory)).toBe(CLOSED) // closed by its remote after an open order
    const other = gate()
    await other.device.externalUpdate({ switch: 'off', doorState: 1 })
    expect(state(other.accessory)).toBe(OPEN) // opened by its remote after a close order
  })

  it('always sends the opposite order and then the wanted one', async () => {
    vi.useFakeTimers()
    const { device, accessory, platform } = gate()
    await device.externalUpdate({ switch: 'on', doorState: 0 })

    const order = device.internalUpdate(OPEN)
    expect(state(accessory)).toBe(OPENING)
    await run(1000)
    await order
    expect(platform.sent.map(s => s.params.switch)).toEqual(['off', 'on'])

    await run(15000)
    expect(state(accessory)).toBe(OPEN)
    await device.externalUpdate({ switch: 'on', doorState: 1 })

    platform.sent.length = 0
    const close = device.internalUpdate(CLOSED)
    expect(state(accessory)).toBe(CLOSING)
    await run(1000)
    await close
    expect(platform.sent.map(s => s.params.switch)).toEqual(['on', 'off'])
    await device.externalUpdate({ switch: 'off', doorState: 0 })
    expect(state(accessory)).toBe(CLOSED) // on the closed limit: closed at once
    device.destroy()
  })

  it('a closing that never reaches the closed limit ends open', async () => {
    vi.useFakeTimers()
    const { device, accessory } = gate()
    await device.externalUpdate({ switch: 'on', doorState: 1 })
    const close = device.internalUpdate(CLOSED)
    await run(1000)
    await close
    await run(15000)
    expect(state(accessory)).toBe(OPEN)
    device.destroy()
  })

  it('an old closed report just after an open order does not close it again', async () => {
    vi.useFakeTimers()
    const { device, accessory } = gate()
    await device.externalUpdate({ switch: 'off', doorState: 0 })
    const order = device.internalUpdate(OPEN)
    await run(1000)
    await order
    await device.externalUpdate({ switch: 'on', doorState: 0 })
    expect(state(accessory)).toBe(OPENING)
    await run(15000)
    expect(state(accessory)).toBe(OPEN)
    device.destroy()
  })

  it('falls back to the http api, and tries again, when the web socket fails', async () => {
    vi.useFakeTimers()
    const httpSent = []
    let httpFails = 1
    const http = {
      updateDevice: async (id, params) => {
        if (httpFails > 0) {
          httpFails -= 1
          throw new Error('{"error": 4002}')
        }
        httpSent.push(params.switch)
      },
      getDeviceParams: async () => undefined,
    }
    const { device, accessory, platform } = gate({ http, failWs: 3 })
    await device.externalUpdate({ switch: 'on', doorState: 0 })
    const order = device.internalUpdate(OPEN)
    await run(10000)
    await order
    // off: 1st try ws and http fail, 2nd try ws fails and http works; on: ws fails, http works
    expect(httpSent).toEqual(['off', 'on'])
    expect(platform.sent).toEqual([])
    expect(state(accessory)).toBe(OPENING)
    device.destroy()
  })

  it('when no order gets through, shows where the gate is and reports the error', async () => {
    vi.useFakeTimers()
    const errors = []
    const http = {
      updateDevice: async () => {
        throw new Error('{"error": 4002}')
      },
      getDeviceParams: async () => undefined,
    }
    const { device, accessory, platform } = gate({ http, failWs: 99 })
    platform.deviceUpdateError = (_a, err) => errors.push(err)
    await device.externalUpdate({ switch: 'on', doorState: 0 })
    const order = device.internalUpdate(OPEN)
    await run(20000)
    await order
    expect(errors).toHaveLength(1)
    expect(state(accessory)).toBe(CLOSED)
    expect(state(accessory, 'TargetDoorState')).toBe(CLOSED)
    device.destroy()
  })

  it('follows the gate opened by its remote, and orders given elsewhere', async () => {
    vi.useFakeTimers()
    const { device, accessory } = gate()
    await device.externalUpdate({ switch: 'off', doorState: 0 })
    await device.externalUpdate({ doorState: 1 }) // remote: off the closed limit
    expect(state(accessory)).toBe(OPENING)
    await run(15000)
    expect(state(accessory)).toBe(OPEN)
    await device.externalUpdate({ switch: 'on', doorState: 1 })
    await device.externalUpdate({ switch: 'off', doorState: 1 }) // eWeLink app: close
    expect(state(accessory)).toBe(CLOSING)
    await device.externalUpdate({ doorState: 0 })
    expect(state(accessory)).toBe(CLOSED)
    device.destroy()
  })

  it('reads the last report from the cloud', async () => {
    const http = { getDeviceParams: async () => ({ switch: 'on', doorState: 0, rssi: -81 }), updateDevice: async () => {} }
    const { device, accessory } = gate({ http })
    await device.externalUpdate({ switch: 'on', doorState: 1 })
    expect(state(accessory)).toBe(OPEN)
    await device.readCloud()
    expect(state(accessory)).toBe(CLOSED)
    device.destroy()
  })
})
