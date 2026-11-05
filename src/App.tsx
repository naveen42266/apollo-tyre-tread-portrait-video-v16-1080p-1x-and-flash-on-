import './App.css'
import { Routes, Route, BrowserRouter } from 'react-router-dom';
import Home from './pages/home/shared';
import AddComplaint from './pages/addComplaint';



function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<Home />} />
        <Route path="/add-complaint" element={<AddComplaint />} />

      </Routes>
    </BrowserRouter>
  )
}

export default App