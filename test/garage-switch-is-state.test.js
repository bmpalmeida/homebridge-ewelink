import { describe, expect, it } from 'vitest'

import deviceTypes from '../lib/device/index.js'
import { buildHandler } from './build-handlers.js'

/**
 * A gate shown as a garage with switchIsState: open and close order exactly
 * what the plain switch orders for on and off, and the shown state follows the
 * order, like the switch shows on/off (doorState is not used).
 */

const OPEN = 0
const CLOSED = 1

function build() {
  const built = buildHandler(
    'sim.deviceGarageOne',
    deviceTypes.sim.deviceGarageOne,
    { deviceConf: { '10001abcde': { switchIsState: true } } },
    { eweUIID: 216 },
  )
  expect(built.error).toBeUndefined()
  const service = built.accessory.getService('GarageDoorOpener')
  return { ...built, service }
}

describe('the garage with switchIsState (#760)', () => {
  it('sends {switch: on} once for open, the same as the switch', async () => {
    const { platform, service } = build()
    await service.getCharacteristic('TargetDoorState').setHandler(OPEN)
    expect(platform.sent).toEqual([{ device: '10001abcde', params: { switch: 'on' } }])
  })

  it('sends {switch: off} once for close', async () => {
    const { platform, service } = build()
    await service.getCharacteristic('TargetDoorState').setHandler(CLOSED)
    expect(platform.sent).toEqual([{ device: '10001abcde', params: { switch: 'off' } }])
  })

  it('shows the order at once, like the switch: open on open, closed on close', async () => {
    const { service } = build()
    await service.getCharacteristic('TargetDoorState').setHandler(OPEN)
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(OPEN)
    await service.getCharacteristic('TargetDoorState').setHandler(CLOSED)
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(CLOSED)
  })

  it('ignores doorState: the state follows the switch only', async () => {
    const { device, service } = build()
    await device.externalUpdate({ switch: 'on', doorState: 0 })
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(OPEN)
    await device.externalUpdate({ doorState: 1 })
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(OPEN)
  })

  it('follows the switch when a report has no doorState', async () => {
    const { device, service } = build()
    await device.externalUpdate({ switch: 'on' })
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(OPEN)
    await device.externalUpdate({ switch: 'off' })
    expect(service.getCharacteristic('CurrentDoorState').value).toBe(CLOSED)
  })
})
