---
name: javascript-typescript-jest
description: 'Best practices for writing JavaScript/TypeScript tests using Jest, including mocking strategies, test structure, and common patterns.'
---

> [!NOTE]
> **Repo adaptation (added at import — not upstream text).** The active test runner in
> this repository is **Vitest 5**, configured in `arista-webui/vitest.config.ts`
> (jsdom + Testing Library; see `arista-webui/src/setupTests.ts`). Keep this skill as
> *guidance* for test structure, mocking strategy, and patterns. Translate Jest-specific
> APIs when writing code here: `jest.fn()` → `vi.fn()`, `jest.spyOn` → `vi.spyOn`,
> `jest.mock` → `vi.mock`, `jest.useFakeTimers()` → `vi.useFakeTimers()`,
> `expect(...).toHaveBeenCalledWith` etc. are the same, and `describe/it/expect/assertSame`
> are imported from `'vitest'` (globals are disabled). Do not add Jest dependencies or
> `jest.config.*` files to `arista-webui`.

### Test Structure
- Name test files with `.spec.ts` or `.spec.tsx` suffix
- Place test files next to the code they test or in a dedicated `__tests__` directory
- Use descriptive test names that explain the expected behavior
- Use nested describe blocks to organize related tests
- Follow the pattern: `describe('Component/Function/Class', () => { it('should do something', () => {}) })`

### Effective Mocking
- Mock external dependencies (APIs, databases, etc.) to isolate your tests
- Use `jest.mock()` for module-level mocks
- Use `jest.spyOn()` for specific function mocks
- Use `mockImplementation()` or `mockReturnValue()` to define mock behavior
- Reset mocks between tests with `jest.resetAllMocks()` in `afterEach`

### Testing Async Code
- Always return promises or use async/await syntax in tests
- Use `resolves`/`rejects` matchers for promises
- Set appropriate timeouts for slow tests with `jest.setTimeout()`

### Snapshot Testing
- Use snapshot tests for UI components or complex objects that change infrequently
- Keep snapshots small and focused
- Review snapshot changes carefully before committing

### Testing React Components
- Use React Testing Library over Enzyme for testing components
- Test user behavior and component accessibility
- Query elements by accessibility roles, labels, or text content
- Use `userEvent` over `fireEvent` for more realistic user interactions

## Common Jest Matchers
- Basic: `expect(value).toBe(expected)`, `expect(value).toEqual(expected)`
- Truthiness: `expect(value).toBeTruthy()`, `expect(value).toBeFalsy()`
- Numbers: `expect(value).toBeGreaterThan(3)`, `expect(value).toBeLessThanOrEqual(3)`
- Strings: `expect(value).toMatch(/pattern/)`, `expect(value).toContain('substring')`
- Arrays: `expect(array).toContain(item)`, `expect(array).toHaveLength(3)`
- Objects: `expect(object).toHaveProperty('key', value)`
- Exceptions: `expect(fn).toThrow()`, `expect(fn).toThrow(Error)`
- Mock functions: `expect(mockFn).toHaveBeenCalled()`, `expect(mockFn).toHaveBeenCalledWith(arg1, arg2)`
