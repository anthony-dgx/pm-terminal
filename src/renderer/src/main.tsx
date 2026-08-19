import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { ReaderWindow } from './ReaderWindow.js'
import './styles.css'
import 'highlight.js/styles/github-dark.css'

// A review window loads the same bundle with '#reader'. It is a document, not a
// chat: no sidebar, no composer, no session of its own.
const isReader = window.location.hash === '#reader'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isReader ? <ReaderWindow /> : <App />}</StrictMode>,
)
