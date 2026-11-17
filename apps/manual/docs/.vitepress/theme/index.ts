import DefaultTheme from 'vitepress/theme'
import Version from './Version.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Version', Version)
  },
}
