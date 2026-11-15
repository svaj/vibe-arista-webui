/**
 * F8 (#70) redaction applied to every artifact this lane produces (docs/CEOS.md item 4:
 * "Capture redacted diagnostics"; README rule: "scrubbing host/user/serial/MAC").
 *
 * The redacted forms are the ones arista-webui/src/testing/redaction-guard.ts accepts:
 * MACs collapse to a zeroed host half (00:00:00:00:00:00), serial-looking values collapse
 * to '0000000000', and credential-shaped assignments collapse to <redacted> (DR-011 token).
 * Device hostname/EOS version are deliberately KEPT: the connected UI renders them openly
 * (identity chip) and they are already public cEOS evidence — the F8 contract targets
 * credentials and identifying hardware fields (serial/MAC), not what the screen displays.
 */

const MAC = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/giu
const SERIAL = /\b(serial(?:number)?["']?\s*[:=]\s*)["']?[0-9A-Za-z]+["']?/giu
const CREDENTIAL = /\b(enablePassword|EAPI_PASS(?:WORD)?|password|passwd|passcode)["']?\s*[:=]\s*["']?[^\s"',}]+/giu
const BASIC = /authorization\s*[:=]\s*basic\s+[a-z0-9+/=]+/giu
const EOS_SECRET = /\bsecret\s+(?:0|5|7|sha512)\s+\S+/giu

/** Replace every identifying/credential-bearing pattern the guard refuses with its redacted form. */
export function scrub(text: string): string {
  return text
    .replace(MAC, '00:00:00:00:00:00')
    .replace(SERIAL, '$1\'0000000000\'')
    .replace(CREDENTIAL, '$1=<redacted>')
    .replace(BASIC, 'authorization: <redacted>')
    .replace(EOS_SECRET, 'secret <redacted>')
}
