import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { AppFrame } from './AppFrame'
import { LocaleProvider } from './locale'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import './home.css'
import './tabbar.css'
import { installScreenTips } from '@genoffice/ui'

installScreenTips()

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('vib')

// resolve the persisted language and theme before first paint to avoid flashes
void Promise.all([window.aiOffice.getLanguage(), window.aiOffice.getTheme()]).then(
  ([lang, theme]) => {
    document.documentElement.lang = htmlLang(lang)
    // apply theme attribute before first paint to avoid flash
    if (theme !== 'system') {
      document.documentElement.setAttribute('data-theme', theme)
    }
    window.aiOffice.onThemeChanged((next) => {
      if (next === 'system') document.documentElement.removeAttribute('data-theme')
      else document.documentElement.setAttribute('data-theme', next)
    })
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <LocaleProvider initial={lang}>
          <AppFrame />
        </LocaleProvider>
      </React.StrictMode>,
    )
  },
)
