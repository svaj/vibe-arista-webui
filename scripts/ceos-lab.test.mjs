import assert from 'node:assert/strict'
import test from 'node:test'

import { redactCredentialText } from './ceos-lab.mjs'

test('redacts credential values without consuming EOS command text across line boundaries', () => {
  const input = [
    'no enable password',
    '!',
    'spanning-tree bpduguard enable',
    '!',
    'aaa authentication enable default local',
    'aaa authentication login default local',
    'username lab secret sha512 $6$hash',
    'enable password lab-enable-password',
    'enable algorithm sha512 password lab-hash',
    'login password lab-login-password',
    'login secret lab-login-secret',
    'passphrase lab-passphrase',
  ].join('\n')

  assert.equal(
    redactCredentialText(input, []),
    [
      'no enable password',
      '!',
      'spanning-tree bpduguard enable',
      '!',
      'aaa authentication enable default local',
      'aaa authentication login default local',
      'username lab secret sha512 <redacted-lab-secret>',
      'enable password <redacted-lab-secret>',
      'enable algorithm sha512 password <redacted-lab-secret>',
      'login password <redacted-lab-secret>',
      'login secret <redacted-lab-secret>',
      'passphrase <redacted-lab-secret>',
    ].join('\n'),
  )
})
