/** Render the owned application and tray artwork with the maintained SVG renderer. */
import { resolve } from 'node:path'
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
const resources = resolve(import.meta.dirname, '../resources')
await sharp(resolve(resources, 'icon.svg')).resize(1024, 1024).png().toFile(resolve(resources, 'icon.png'))
const badges = resolve(resources, 'badges')
mkdirSync(badges, { recursive: true })
for (const label of [...Array.from({ length: 99 }, (_, index) => String(index + 1)), '99+']) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="1" y="16" width="94" height="64" rx="30" fill="#be343c"/><text x="48" y="61" font-family="Segoe UI,Arial,sans-serif" font-weight="600" font-size="${label.length === 3 ? 38 : 46}" fill="white" text-anchor="middle">${label}</text></svg>`
  const overlay = await sharp(Buffer.from(svg)).png().toBuffer()
  await sharp(overlay).toFile(resolve(badges, `${label}.png`))
  await sharp(resolve(resources, 'icon.svg')).resize(96, 96).composite([{ input: await sharp(overlay).resize(64, 64).toBuffer(), gravity: 'southeast' }]).png().toFile(resolve(badges, `tray-${label}.png`))
}
