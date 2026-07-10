I work on the frontend for PlanBoard, our internal dashboard. We're on React 18 with TypeScript and Tailwind, and all our shared UI lives in one design-system package, `@planboard/ui`, that a couple of other internal apps also depend on.

I want to add a `Toast` notification component to that package, importable as `Toast` from `@planboard/ui`. It needs four variants -- success, error, warning, and info -- each with its own icon and color, and those colors need to match the design tokens we already have defined in `tailwind.config.js`, not new ad-hoc colors.

By default a toast should auto-dismiss after 5 seconds, but that needs to be overridable per toast for cases where someone wants it to stay up longer. It'd be nice to support an optional action button too, like "Undo," for toasts where that makes sense, and a manual close (x) button so people can dismiss early if they want.

When there's more than one toast showing, they should stack vertically with the newest one on top.

Accessibility is a hard requirement here, not a nice-to-have -- screen readers need to actually announce new toasts as they appear, so this needs proper aria-live handling, not just visual styling.

If there's time, a Storybook story for each of the four variants would be great for the design team to reference.

Since you're asking about the surrounding context: `@planboard/ui` is consumed by two other internal apps beyond PlanBoard itself, and neither of them pins an exact version -- they just take whatever's published. So a breaking change to the Toast prop API wouldn't just be caught in our own build, it'd silently break theirs too. And separately, a chunk of our enterprise customers run with `prefers-reduced-motion` enforced at the OS level, so the dashboard -- Toast included -- has to stay fully functional with all animations disabled.
