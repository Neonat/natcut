# Third-party notices

NatCut's PixCut S1 protocol work is inspired by [BrenCut](https://github.com/LTKMN/brencut), Copyright (c) 2026 brennan (LTKMN), used under the MIT License. BrenCut established the JavaScript transport abstraction, framing behavior, read-only status flow, and tested device constants that informed this implementation.

The protocol was originally reverse-engineered by [PixCut-App](https://github.com/popcornhax/PixCut-App), used under the MIT License.

The alpha-mask contour tracer in `vendor/pixcut-trace` is copied from BrenCut at
commit `b153c614f441dbc663e2fafeb66ef1f731191872`. Its original MIT license and
source record are preserved in that directory. NatCut owns its distance-field,
clearance, collision, warning, and complexity-policy code.

[honeymaro/pixcut](https://github.com/honeymaro/pixcut) is also credited by the
upstream tracer and is used under the MIT License.

## BrenCut MIT License

Copyright (c) 2026 brennan (LTKMN)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
