// Extends Vitest expectations with jest-dom matchers (toBeInTheDocument, etc.).
import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library's auto-cleanup only registers when globals are enabled,
// so tear down rendered trees explicitly between tests.
afterEach(() => {
  cleanup()
})
