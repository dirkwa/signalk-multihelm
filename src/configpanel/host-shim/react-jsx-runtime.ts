import type * as JSXRuntimeNS from 'react/jsx-runtime'

const host = window.__SK_REACT_JSX_RUNTIME__
if (!host) {
  throw new Error('signalk-multihelm: the admin UI does not expose React (Signal K 2.27 or later)')
}

const j: typeof JSXRuntimeNS = host

export const { Fragment, jsx, jsxs } = j
