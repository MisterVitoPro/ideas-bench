# Acceptance checklist -- s03-ui-component

- [ ] A `Toast` component exists, exported from `@planboard/ui`, built in React 18 + TypeScript + Tailwind.
- [ ] Four variants are supported: success, error, warning, info, each with a distinct icon and color.
- [ ] Variant colors use the existing design tokens from tailwind.config.js rather than new ad-hoc colors.
- [ ] Toasts auto-dismiss after 5 seconds by default, and that duration is overridable per toast.
- [ ] Multiple simultaneous toasts stack vertically with the newest on top.
- [ ] New toasts are announced to screen readers via proper aria-live handling.
- [ ] The Toast prop API avoids an unannounced breaking change, given two other internal apps consume @planboard/ui without pinning exact versions.
- [ ] The component (including toasts) remains fully functional with animations disabled under prefers-reduced-motion.
- [ ] (Nice-to-have) An optional action button (e.g. "Undo") is supported.
- [ ] (Nice-to-have) A manual close (x) button is available on each toast.
- [ ] (Nice-to-have) A Storybook story exists for each of the four variants.
