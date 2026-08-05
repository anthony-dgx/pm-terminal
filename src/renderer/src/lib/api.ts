import type { DeskApi } from '../../../preload/index.js'

declare global {
  interface Window {
    desk: DeskApi
  }
}

export const desk = window.desk
