// The admin UI puts its React on window before it loads a panel; the shims
// hand the panel that instance, so hooks run on the host's dispatcher.
declare global {
  interface Window {
    __SK_REACT__?: typeof import('react')
    __SK_REACT_JSX_RUNTIME__?: typeof import('react/jsx-runtime')
  }
}

export {}
