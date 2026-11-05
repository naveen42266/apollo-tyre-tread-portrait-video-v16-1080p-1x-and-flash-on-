// App.tsx - Main Component with Routing
import React, { useState } from 'react';
import HomePage from './HomePage';
import TyreTreadRecorder from './TyreTreadRecorder';
import PreviewPage from './PreviewPage';


export type AppScreen = 'HOME' | 'RECORDER' | 'PREVIEW';

export interface RecordedVideo {
  blob: Blob;
  url: string;
  timestamp: number;
}

const Checking: React.FC = () => {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>('HOME');
  const [recordedVideo, setRecordedVideo] = useState<RecordedVideo | null>(null);

  const handleStartCapture = () => {
    setCurrentScreen('RECORDER');
  };

  const handleRecordingComplete = (videoBlob: Blob) => {
    const url = URL.createObjectURL(videoBlob);
    setRecordedVideo({
      blob: videoBlob,
      url: url,
      timestamp: Date.now()
    });
    setCurrentScreen('PREVIEW');
  };

  const handleRetake = () => {
    if (recordedVideo?.url) {
      URL.revokeObjectURL(recordedVideo.url);
    }
    setRecordedVideo(null);
    setCurrentScreen('RECORDER');
  };

  const handleNewCapture = () => {
    if (recordedVideo?.url) {
      URL.revokeObjectURL(recordedVideo.url);
    }
    setRecordedVideo(null);
    setCurrentScreen('HOME');
  };

  const handleSave = () => {
    if (recordedVideo) {
      // Create download link
      const a = document.createElement('a');
      a.href = recordedVideo.url;
      a.download = `tyre-tread-${new Date().toISOString()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <div className="App">
      {currentScreen === 'HOME' && (
        <HomePage onStartCapture={handleStartCapture} />
      )}
      {currentScreen === 'RECORDER' && (
        <TyreTreadRecorder onRecordingComplete={handleRecordingComplete} />
      )}
      {currentScreen === 'PREVIEW' && recordedVideo && (
        <PreviewPage
          videoUrl={recordedVideo.url}
          onRetake={handleRetake}
          onSave={handleSave}
          onNewCapture={handleNewCapture}
        />
      )}
    </div>
  );
};

export default Checking;