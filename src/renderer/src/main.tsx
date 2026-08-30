import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ReaderWindow } from './ReaderWindow.js'
// Tokens first: styles.css and the theme blocks both build on them.
import './design/tokens.css'
import './styles.css'
// The redesigned shell, loaded after styles.css so it can retune the older
// rules in place rather than forking them. One file per surface.
import './design/shell.css'
import './design/sessions.css'
import './design/transcript.css'
import './design/inspector.css'
import 'highlight.js/styles/github-dark.css'

// A review window loads the same bundle with '#reader'. It is a document, not a
// chat: no sidebar, no composer, no session of its own.
const isReader = window.location.hash === '#reader'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isReader ? <ReaderWindow /> : <App />}</StrictMode>,
)
