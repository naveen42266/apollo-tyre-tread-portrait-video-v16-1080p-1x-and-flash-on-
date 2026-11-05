import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
// import '@fontsource/montserrat';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/700.css';
import { Provider } from 'react-redux';
import { store } from './store/index.ts';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
)
