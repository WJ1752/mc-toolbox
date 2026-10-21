import test from 'node:test'
import assert from 'node:assert/strict'
import { optimizedJvmArgs, hasOptimizedJvm, OPTIMIZED_JVM_FLAGS } from '../public/js/launcher/jvm.js'

test('optimizedJvmArgs writes the full preset once', () => {
  const first = optimizedJvmArgs('')
  assert.ok(first.includes('-XX:+UseG1GC'))
  assert.ok(first.includes('-XX:MaxGCPauseMillis=200'))
  const second = optimizedJvmArgs(first)
  assert.equal(second, first)
  for (const flag of OPTIMIZED_JVM_FLAGS) {
    assert.equal(second.split(/\s+/).filter((item) => item === flag).length, 1, flag)
  }
})

test('optimizedJvmArgs keeps user flags and replaces stale values', () => {
  const merged = optimizedJvmArgs('-Xmx8G -Dfoo=bar -XX:MaxGCPauseMillis=500 -XX:+UseG1GC -XX:G1HeapRegionSize=16M')
  assert.ok(merged.includes('-Xmx8G'))
  assert.ok(merged.includes('-Dfoo=bar'))
  assert.ok(merged.includes('-XX:MaxGCPauseMillis=200'))
  assert.ok(merged.includes('-XX:G1HeapRegionSize=8M'))
  assert.ok(!merged.includes('-XX:MaxGCPauseMillis=500'))
  assert.ok(!merged.includes('-XX:G1HeapRegionSize=16M'))
})

test('hasOptimizedJvm detects complete and partial presets', () => {
  assert.equal(hasOptimizedJvm(optimizedJvmArgs('')), true)
  assert.equal(hasOptimizedJvm('-XX:+UseG1GC'), false)
  assert.equal(hasOptimizedJvm(''), false)
})
