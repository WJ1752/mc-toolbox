import test from 'node:test'
import assert from 'node:assert/strict'
import { readSkinPng } from '../src/server/launcher/skins.js'
import { uploadMinecraftSkin } from '../src/server/launcher/accounts.js'

const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlUlEQVR4nO3QMREAIBDAsAf8awYZGeiQvddZ+9yfjQ7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkB7HT9Q8VmTgFoAAAAASUVORK5CYII='

test('皮肤上传提交所选模型与相同的 PNG，读取官方返回的活动皮肤', async () => {
  const png = readSkinPng(data)
  const skin = { model: 'slim', data }
  const result = await uploadMinecraftSkin('test-only', skin, png, async (url, init) => {
    assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile/skins')
    assert.equal(init.headers.Authorization, 'Bearer test-only')
    assert.equal(init.body.get('variant'), 'slim')
    assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), png)
    return Response.json({ skins: [{ state: 'ACTIVE', url: 'https://example.invalid/texture' }] })
  })
  assert.equal(result, 'https://example.invalid/texture')
  await assert.rejects(uploadMinecraftSkin('invalid', skin, png, () => new Response('', { status: 403 })), /403/)
  assert.throws(() => readSkinPng('data:image/png;base64,eA=='), /PNG/)
})
