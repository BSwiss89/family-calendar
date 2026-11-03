// Single-family LIVE pilot, standards-based RFC 8291 / RFC 8292 Web Push.
// No third-party API, paid service, or Apple Developer enrollment.
// Do not expose raw endpoints, auth keys or VAPID private key to clients/logs.
import { createECDH, createPrivateKey, createCipheriv, createHmac, createSign, randomBytes } from 'node:crypto'

export function decodeUrl64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 200) {
    throw new Error('Invalid encoded key.')
  }
  const bytes = Buffer.from(value, 'base64url')
  if (length && bytes.length !== length) throw new Error('Invalid key length.')
  return bytes
}

function hkdfExtract(salt, input) {
  return createHmac('sha256', salt).update(input).digest()
}

function hkdfExpand(prk, info, size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 32) throw new Error('Invalid HKDF size.')
  return createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest().subarray(0,size)
}

function vapidKeypair(privateBase64) {
  const secret = decodeUrl64(privateBase64,32)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(secret)
  const raw = ecdh.getPublicKey(undefined,'uncompressed')
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Invalid VAPID keypair.')
  const key = createPrivateKey({
    key: {kty:'EC',crv:'P-256',d:secret.toString('base64url'),
      x:raw.subarray(1,33).toString('base64url'),
      y:raw.subarray(33).toString('base64url')},
    format:'jwk',
  })
  return {raw,key}
}

export function publicVapidKey(privateBase64) {
  return vapidKeypair(privateBase64).raw.toString('base64url')
}

// Restrict destinations to real browser push-service hostnames to avoid SSRF.
// HTTPS endpoints are credentials; never follow redirects or print URLs.
export function approvedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  let url
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false
  const host = url.hostname.toLowerCase()
  return host === 'fcm.googleapis.com' ||
    host === 'fcm-xm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.apple.com') ||
    host === 'web.push.apple.com'
}

export function encodePush({endpoint,p256dh,auth,payload,privateKey,subject,at=Date.now()}) {
  if (!approvedPushEndpoint(endpoint)) throw new Error('Unsupported push service.')
  if (typeof subject !== 'string' ||
      !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
    throw new Error('A valid VAPID contact is required.')
  }
  const client = decodeUrl64(p256dh,65)
  if (client[0] !== 4) throw new Error('Invalid client public key.')
  const authSecret = decodeUrl64(auth,16)
  const server = createECDH('prime256v1')
  server.generateKeys()
  const serverPub = server.getPublicKey(undefined,'uncompressed')
  const sharedSecret = server.computeSecret(client)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'),client,serverPub])
  const ikm = hkdfExpand(hkdfExtract(authSecret,sharedSecret),info,32)
  const salt = randomBytes(16)
  const prk = hkdfExtract(salt,ikm)
  const cek = hkdfExpand(prk,Buffer.from('Content-Encoding: aes128gcm\0'),16)
  const nonce = hkdfExpand(prk,Buffer.from('Content-Encoding: nonce\0'),12)
  const message = Buffer.from(JSON.stringify(payload),'utf8')
  if (message.length > 2400) throw new Error('Push payload is too large.')
  const cipher = createCipheriv('aes-128-gcm',cek,nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([message,Buffer.from([2])])),cipher.final()])
  const body = Buffer.allocUnsafe(16+4+1+65+ciphertext.length+16)
  let offset=0
  salt.copy(body,offset); offset+=16
  body.writeUInt32BE(4096,offset); offset+=4
  body.writeUInt8(serverPub.length,offset); offset++
  serverPub.copy(body,offset); offset+=serverPub.length
  ciphertext.copy(body,offset); offset+=ciphertext.length
  cipher.getAuthTag().copy(body,offset)
  const {raw,key} = vapidKeypair(privateKey)
  const audience = new URL(endpoint).origin
  const exp = Math.floor(at/1000)+3600
  const header = Buffer.from(JSON.stringify({typ:'JWT',alg:'ES256'})).toString('base64url')
  const claims = Buffer.from(JSON.stringify({aud:audience,exp,sub:subject})).toString('base64url')
  const messageToSign = header+'.'+claims
  const signer = createSign('sha256')
  signer.update(messageToSign); signer.end()
  const signature = signer.sign({key,dsaEncoding:'ieee-p1363'}).toString('base64url')
  return {
    body,
    headers: {
      'Content-Encoding':'aes128gcm',
      'Content-Type':'application/octet-stream',
      'Authorization':'vapid t='+messageToSign+'.'+signature+', k='+raw.toString('base64url'),
      'TTL':'3600',
      'Urgency':'normal',
    },
  }
}

export async function sendWebPush(subscription,notification,config,{fetchImpl=fetch}={}) {
  const request = encodePush({
    endpoint:subscription.endpoint,p256dh:subscription.p256dh,auth:subscription.auth,
    payload:notification,privateKey:config.privateKey,subject:config.subject,
  })
  const response = await fetchImpl(subscription.endpoint,{
    method:'POST',headers:request.headers,body:request.body,
    redirect:'error',signal:AbortSignal.timeout(8000),
  })
  return response.status
}
