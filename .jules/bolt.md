## 2025-02-14 - Swap-pop & Math.sqrt optimizations in game loops
**Learning:** `Math.hypot(x, y)` is significantly slower in V8 than `Math.sqrt(x*x + y*y)` due to internal checks for variable arguments and overflow protections. Additionally, `Array.splice(idx, 1)` causes an O(N) shift which is a bottleneck in high-entity tracking arrays. Swap-and-pop is O(1) and much faster for unordered sets.
**Action:** Always prefer `Math.sqrt` over `Math.hypot` in hot game loops. Replace `splice` with swap-and-pop when order does not matter.
