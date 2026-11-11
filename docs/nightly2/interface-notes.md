# Interface Notes — Nightly 2

## Problem 2: Call Overlay Obscuring Message Input

### Cause
In `src/app/App.tsx`, `<ActiveCallBar />` was rendered as a root floating element with `fixed bottom-4 left-1/2 -translate-x-1/2 z-50` (in `src/components/ActiveCallBar.tsx`).
When users navigated to conversations (`activeTab === 'messages'`), the bottom floating bar centered itself directly over the chat input box, attachment buttons, and message stream in `MessagesView.tsx`. On narrow windows, it completely covered the composer.

### Evidence
- File `src/components/ActiveCallBar.tsx`:
  Line 56: `<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 select-none animate-in fade-in slide-in-from-bottom-4 duration-200">`
- File `src/app/App.tsx`:
  Line 212: `<ActiveCallBar />` rendered outside the sidebar at root level.
- File `src/features/messages/MessagesView.tsx`:
  Chat input form is docked at the bottom center/right of `<main>`, directly under `fixed bottom-4 left-1/2`.

### Fix
1. Move the display of `<ActiveCallBar />` out of the global floating layer in `App.tsx` and integrate it directly into the left sidebar (`src/app/Sidebar.tsx`), above the bottom dock.
2. Inside `src/components/ActiveCallBar.tsx`, redesign the layout to cleanly fit the sidebar in both states:
   - **Expanded sidebar (`w-60`)**: Horizontal card displaying peer avatar (with speaking glow), peer name, status badge (duration / reconnecting / calling), remote mic muted indicator, screen share indicator, and action buttons: Mute mic, Deafen, Return to call (`Maximize2`), and Disconnect (`PhoneOff`).
   - **Collapsed sidebar (`w-16`)**: Compact vertical stack displaying peer avatar with status pulse and tooltip, mute, deafen, return to call, and disconnect button.
3. This guarantees the call bar is strictly confined to the sidebar (`<aside>`), completely eliminating any overlap with `<main>` or the message composer.
4. Adapt smoothly to window width and sidebar state without introducing redundant components.

---

## Problem 3: CallsView Layout Modes (Compacto / Equilibrado / Cinema) Wasting Space

### Cause
In `src/features/calls/CallsView.tsx`:
1. The video container had a hardcoded `max-w-5xl` class (1024px) along with heavy padding `p-4 sm:p-6 pb-24`, resulting in massive wasted space on 1080p and 1440p displays.
2. "Compacto", "Equilibrado", and "Cinema" were only implemented as split ratios (`ratio: 45`, `65`, `80`) adjusting the height of a container still constrained to `max-w-5xl`.
3. In "Cinema" mode:
   - Video did not fill usable area because of `max-w-5xl` and `pb-24`.
   - Participants remained as large cards beneath the video, taking up huge vertical height.
   - The left sidebar remained expanded (240px) unless manually collapsed.
   - Controls remained in a large floating dock consuming bottom padding.
4. Aspect ratio:
   - While video tracks used `object-contain`, container proportions didn't adapt well to screen sizes.

### Evidence
- `src/features/calls/CallsView.tsx`:
  - Line 867: `w-full max-w-5xl bg-nexus-surface/95 border border-nexus-border rounded-2xl overflow-hidden shadow-2xl flex flex-col shrink-0 transition-colors`
  - Lines 942-947:
    ```ts
    [
      { label: 'Compacto', ratio: 45 },
      { label: 'Equilibrado', ratio: 65 },
      { label: 'Cinema', ratio: 80 },
    ]
    ```
  - Lines 1104-1107: Participant grid beneath the stage with rigid cards.
  - Line 1390: Floating bottom dock requiring `pb-24` on the stage container.

### Fix
1. Implement first-class layout modes: `compact`, `balanced`, and `cinema` with pure layout logic in `src/lib/callsLayout.ts`.
2. **Compacto (`compact`)**:
   - Stage occupies a moderate split (~45% height or max-w-5xl).
   - Full participant cards visible below stage with avatar, speaking status, and volume slider.
   - Standard sidebar.
3. **Equilibrado (`balanced`)**:
   - Larger stream area (~68% height, up to max-w-6xl or full width with comfortable margins).
   - Compact participant strip (horizontal compact tiles saving vertical space).
   - Standard sidebar.
4. **Cinema (`cinema`)**:
   - Stream expands to maximum usable area: `w-full h-full`, removing `max-w-5xl` artificial limitations.
   - Collapsible sidebar integration (sidebar collapsed or easily toggled, giving maximum horizontal width).
   - Participant strip rendered as an ultra-compact overlay or discreet top/bottom strip.
   - Controls discreetly overlaid on the video with backdrop blur, accessible on hover/interaction without consuming permanent screen margins.
   - Video strictly preserves native aspect ratio (`object-contain`), without distortion.
5. **Fullscreen Independence**:
   - True DOM/OS Fullscreen toggle remains completely independent from Cinema mode.
   - Entering and exiting Fullscreen restores the previously active layout mode (`compact`, `balanced`, or `cinema`).
6. **No-Stream Graceful Fallback**:
   - When no screen is being shared, participant grid is cleanly formatted in voice-only layout.
7. **Accessibility & Diagnostics**:
   - Keyboard navigation, ARIA attributes (`aria-label`, `role="region"`, `aria-pressed`), and support for reduced motion.
   - Diagnostics telemetry ready to display requested/captured/sent/received/rendered FPS as exposed by `@streaming`.
