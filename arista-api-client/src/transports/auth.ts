/**
 * Basic-auth header construction — M2 (#4), port of `EapiConnection.authentication`
 * (`pyeapi/eapilib.py:288-303`, BSD-3-Clause Arista Networks — DR-001).
 *
 * pyeapi does:
 *
 * ```python
 * _auth_text = '{}:{}'.format(username, password)
 * _auth_bin  = base64.encodebytes(_auth_text.encode())   # UTF-8 bytes
 * _auth      = _auth_bin.decode().replace('\n', '')
 * self._auth = ("Authorization", "Basic %s" % _auth)
 * ```
 *
 * Two details are worth pinning with tests, because a hand-rolled `btoa(username + ':' + password)`
 * gets both wrong:
 *  1. the value is the base64 of the **UTF-8 bytes**, so a non-ASCII password must be percent-wise
 *     identical to pyeapi (a switch configured with a UTF-8 secret is not a hypothetical);
 *  2. `base64.encodebytes` wraps at 76 chars and `replace('\n','')` unwraps it, so the header has no
 *     line breaks for any credential length.
 *
 * Browser-safe (TextEncoder only — no `Buffer`, no `node:buffer`).
 */

import type { CredentialOptions } from './contract'

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 of the UTF-8 encoding of `text`, without line breaks — byte-parity with pyeapi. */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number
    const second = index + 1 < bytes.length ? (bytes[index + 1] as number) : undefined
    const third = index + 2 < bytes.length ? (bytes[index + 2] as number) : undefined
    out += BASE64_ALPHABET.charAt(first >> 2)
    if (second === undefined) {
      out += `${BASE64_ALPHABET.charAt((first & 0b11) << 4)}==`
      continue
    }
    out += BASE64_ALPHABET.charAt(((first & 0b11) << 4) | (second >> 4))
    if (third === undefined) {
      out += `${BASE64_ALPHABET.charAt((second & 0b1111) << 2)}=`
      continue
    }
    out += BASE64_ALPHABET.charAt(((second & 0b1111) << 2) | (third >> 6))
    out += BASE64_ALPHABET.charAt(third & 0b11_1111)
  }
  return out
}

/** `Basic <base64(username:password)>` — the exact header value pyeapi sends. */
export function basicAuth(username: string, password = ''): string {
  return `Basic ${base64Utf8(`${username}:${password}`)}`
}

/**
 * Resolve the credential pair to a header, or to nothing.
 *
 * "Absent when credentials are absent" is the behaviour the ported header test asserts: an eAPI
 * listener that is configured with no AAA on the local transports must not be handed an
 * `Authorization` header at all, and a browser direct-CORS call may want the proxy to inject it
 * (DR-036). A password without a username is a caller mistake and throws.
 */
export function authorizationHeader(credentials: CredentialOptions): string | undefined {
  const { username, password } = credentials
  if (username === undefined) {
    if (password !== undefined) {
      throw new TypeError('password given without username: eAPI Basic auth needs both (pyeapi defaults to the string "None:None")')
    }
    return undefined
  }
  return basicAuth(username, password ?? '')
}
