// components/HomePage.tsx
import React from 'react';

interface HomePageProps {
  onStartCapture: () => void;
}

const HomePage: React.FC<HomePageProps> = ({ onStartCapture }) => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex flex-col items-center justify-center p-6">
      {/* Logo/Brand Section */}
      <div className="text-center mb-12 animate-fade-in">
        <div className="inline-block p-4 bg-blue-600 rounded-full mb-6">
          <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-4xl font-bold text-white mb-3">TyreScan Pro</h1>
        <p className="text-gray-300 text-lg">Professional Tyre Tread Scanner</p>
      </div>

      {/* Features Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto mb-12">
        <div className="bg-white/10 backdrop-blur-lg rounded-xl p-6 text-center">
          <div className="text-blue-400 text-3xl mb-3">📱</div>
          <h3 className="text-white font-semibold mb-2">Easy Scanning</h3>
          <p className="text-gray-300 text-sm">Simply move your camera across the tyre tread</p>
        </div>
        <div className="bg-white/10 backdrop-blur-lg rounded-xl p-6 text-center">
          <div className="text-blue-400 text-3xl mb-3">🎯</div>
          <h3 className="text-white font-semibold mb-2">Precision Crop</h3>
          <p className="text-gray-300 text-sm">Automatically captures the left 28% of the frame</p>
        </div>
        <div className="bg-white/10 backdrop-blur-lg rounded-xl p-6 text-center">
          <div className="text-blue-400 text-3xl mb-3">💾</div>
          <h3 className="text-white font-semibold mb-2">Instant Save</h3>
          <p className="text-gray-300 text-sm">Preview and save your scans instantly</p>
        </div>
      </div>

      {/* Instructions */}
      <div className="bg-gray-800/50 rounded-lg p-6 max-w-2xl mx-auto mb-8">
        <h2 className="text-white font-semibold mb-3 text-center">How to Scan:</h2>
        <div className="space-y-2 text-gray-300">
          <div className="flex items-center space-x-3">
            <span className="bg-blue-600 rounded-full w-6 h-6 flex items-center justify-center text-sm">1</span>
            <span>Position the tyre tread at the green start zone</span>
          </div>
          <div className="flex items-center space-x-3">
            <span className="bg-blue-600 rounded-full w-6 h-6 flex items-center justify-center text-sm">2</span>
            <span>Wait 2 seconds for stabilization</span>
          </div>
          <div className="flex items-center space-x-3">
            <span className="bg-blue-600 rounded-full w-6 h-6 flex items-center justify-center text-sm">3</span>
            <span>Slowly move camera across the tread to the red end zone</span>
          </div>
        </div>
      </div>

      {/* Capture Button */}
      <button
        onClick={onStartCapture}
        className="group relative bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold py-4 px-8 rounded-full transition-all duration-300 transform hover:scale-105 shadow-lg"
      >
        <div className="flex items-center space-x-3">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span className="text-lg">Start New Scan</span>
        </div>
      </button>

      <style>{`
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
          animation: fade-in 0.6s ease-out;
        }
      `}</style>
    </div>
  );
};

export default HomePage;