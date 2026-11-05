// import React, { useState, useRef } from 'react';
// import { ArrowLeft, Camera, Image as ImageIcon, X, Upload, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
// import CameraCapture from '../cameraCapture';
// import { useNavigate } from 'react-router-dom';

// interface AddComplaintProps {

// }

// const AddComplaint: React.FC<AddComplaintProps> = () => {
//   const [capturedImages, setCapturedImages] = useState<string[]>([]);
//   const [showCamera, setShowCamera] = useState(false);
//   const [previewModal, setPreviewModal] = useState<{ show: boolean; index: number }>({
//     show: false,
//     index: 0
//   });
//   const fileInputRef = useRef<HTMLInputElement>(null);
//   const navigate = useNavigate();
//   const onBack = () => {
//     navigate(-1);
//   }

//   console.log('Captured Images:', capturedImages);

//   // Handle captured image from camera
//   const handleCapturedImage = (imageDataUrl: string) => {
//     setCapturedImages(prev => [...prev, imageDataUrl]);
//     setShowCamera(false);
//   };

//   // Handle gallery upload
//   const handleGalleryUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
//     const files = event.target.files;
//     if (files) {
//       Array.from(files).forEach(file => {
//         const reader = new FileReader();
//         reader.onloadend = () => {
//           setCapturedImages(prev => [...prev, reader.result as string]);
//         };
//         reader.readAsDataURL(file);
//       });
//     }
//   };

//   // Remove image
//   const removeImage = (index: number) => {
//     setCapturedImages(prev => prev.filter((_, i) => i !== index));
//     // Close modal if the removed image was being previewed
//     if (previewModal.show && previewModal.index === index) {
//       setPreviewModal({ show: false, index: 0 });
//     } else if (previewModal.show && previewModal.index > index) {
//       setPreviewModal(prev => ({ ...prev, index: prev.index - 1 }));
//     }
//   };

//   // Open preview modal
//   const openPreview = (index: number) => {
//     setPreviewModal({ show: true, index });
//   };

//   // Close preview modal
//   const closePreview = () => {
//     setPreviewModal({ show: false, index: 0 });
//   };

//   // Navigate to previous image
//   const previousImage = () => {
//     setPreviewModal(prev => ({
//       ...prev,
//       index: prev.index > 0 ? prev.index - 1 : capturedImages.length - 1
//     }));
//   };

//   // Navigate to next image
//   const nextImage = () => {
//     setPreviewModal(prev => ({
//       ...prev,
//       index: prev.index < capturedImages.length - 1 ? prev.index + 1 : 0
//     }));
//   };

//   // Submit complaint
//   const handleSubmit = () => {
//     if (capturedImages.length === 0) {
//       alert('Please capture or upload at least one image');
//       return;
//     }

//     // Handle submission logic here
//     alert(`Complaint submitted with ${capturedImages.length} image(s)`);
//     setCapturedImages([]);
//     onBack();
//   };

//   // Handle keyboard navigation in preview
//   const handleKeyDown = (e: React.KeyboardEvent) => {
//     if (!previewModal.show) return;

//     if (e.key === 'ArrowLeft') {
//       previousImage();
//     } else if (e.key === 'ArrowRight') {
//       nextImage();
//     } else if (e.key === 'Escape') {
//       closePreview();
//     }
//   };

//   return (
//     <div className="min-h-screen bg-gray-50" onKeyDown={handleKeyDown} tabIndex={0}>
//       {/* Show Camera Capture Screen */}
//       {showCamera && (
//         <CameraCapture
//           onCapture={handleCapturedImage}
//           onClose={() => setShowCamera(false)}
//         />
//       )}

//       {/* Image Preview Modal */}
//       {previewModal.show && (
//         <div className="fixed inset-0 z-50 bg-black bg-opacity-95 flex items-center justify-center">
//           <div className="relative w-full h-full flex items-center justify-center p-4">
//             {/* Close Button */}
//             <button
//               onClick={closePreview}
//               className="absolute top-4 right-4 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
//             >
//               <X className="w-6 h-6 text-white" />
//             </button>

//             {/* Image Counter */}
//             <div className="absolute top-4 left-4 px-4 py-2 bg-black bg-opacity-60 rounded-full z-10 backdrop-blur-sm">
//               <p className="text-white text-sm font-medium">
//                 {previewModal.index + 1} / {capturedImages.length}
//               </p>
//             </div>

//             {/* Previous Button */}
//             {capturedImages.length > 1 && (
//               <button
//                 onClick={previousImage}
//                 className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
//               >
//                 <ChevronLeft className="w-8 h-8 text-white" />
//               </button>
//             )}

//             {/* Image */}
//             <img
//               src={capturedImages[previewModal.index]}
//               alt={`Preview ${previewModal.index + 1}`}
//               className="max-w-full max-h-full object-contain"
//             />

//             {/* Next Button */}
//             {capturedImages.length > 1 && (
//               <button
//                 onClick={nextImage}
//                 className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
//               >
//                 <ChevronRight className="w-8 h-8 text-white" />
//               </button>
//             )}

//             {/* Delete Button */}
//             <button
//               onClick={() => {
//                 removeImage(previewModal.index);
//                 if (capturedImages.length === 1) {
//                   closePreview();
//                 }
//               }}
//               className="absolute bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full transition-all z-10 shadow-lg flex items-center gap-2"
//             >
//               <X className="w-5 h-5" />
//               Delete Image
//             </button>
//           </div>
//         </div>
//       )}

//       {/* Header */}
//       <div className="bg-white shadow-sm sticky top-0 z-10">
//         <div className="max-w-md mx-auto px-4 py-4 flex items-center gap-3">
//           <button
//             onClick={onBack}
//             className="p-2 hover:bg-gray-100 rounded-full transition-colors"
//           >
//             <ArrowLeft className="w-6 h-6 text-gray-700" />
//           </button>
//           <h1 className="text-xl md:text-2xl font-semibold text-gray-800">
//             Raise Complaint
//           </h1>
//         </div>
//       </div>

//       <div className="max-w-md mx-auto p-4 pb-24">
//         {/* Upload Options */}
//         <div className="space-y-4 mb-6">
//           {/* Capture from Camera */}
//           <button
//             onClick={() => setShowCamera(true)}
//             className="w-full bg-white rounded-xl shadow-md hover:shadow-lg transition-all p-6 border-2 border-gray-100 hover:border-blue-300 active:scale-98"
//           >
//             <div className="flex items-center gap-4">
//               <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center">
//                 <Camera className="w-6 h-6 text-white" />
//               </div>
//               <div className="text-left flex-1">
//                 <h3 className="text-lg font-semibold text-gray-800">
//                   Capture & Upload
//                 </h3>
//                 <p className="text-sm text-gray-500">
//                   Take a photo using camera
//                 </p>
//               </div>
//             </div>
//           </button>

//           {/* Upload from Gallery */}
//           <button
//             onClick={() => fileInputRef.current?.click()}
//             className="w-full bg-white rounded-xl shadow-md hover:shadow-lg transition-all p-6 border-2 border-gray-100 hover:border-blue-300 active:scale-98"
//           >
//             <div className="flex items-center gap-4">
//               <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center">
//                 <ImageIcon className="w-6 h-6 text-white" />
//               </div>
//               <div className="text-left flex-1">
//                 <h3 className="text-lg font-semibold text-gray-800">
//                   Upload from Gallery
//                 </h3>
//                 <p className="text-sm text-gray-500">
//                   Choose from your photos
//                 </p>
//               </div>
//             </div>
//           </button>

//           <input
//             ref={fileInputRef}
//             type="file"
//             accept="image/*"
//             multiple
//             onChange={handleGalleryUpload}
//             className="hidden"
//           />
//         </div>

//         {/* Image Preview Grid */}
//         {capturedImages.length > 0 && (
//           <div className="mb-6">
//             <h3 className="text-lg font-semibold text-gray-800 mb-3">
//               Preview ({capturedImages.length})
//             </h3>
//             <div className="grid grid-cols-2 gap-3">
//               {capturedImages.map((image, index) => (
//                 <div key={index} className="relative group">
//                   <button
//                     onClick={() => openPreview(index)}
//                     className="w-full h-40 relative rounded-lg overflow-hidden border-2 border-gray-200 hover:border-blue-400 transition-all"
//                   >
//                     <img
//                       src={image}
//                       alt={`Captured ${index + 1}`}
//                       className="w-full h-full object-cover"
//                     />
//                     {/* Zoom overlay on hover */}
//                     <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
//                       <ZoomIn className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-all" />
//                     </div>
//                   </button>

//                   {/* Remove button */}
//                   <button
//                     onClick={(e) => {
//                       e.stopPropagation();
//                       removeImage(index);
//                     }}
//                     className="absolute top-2 right-2 p-1.5 bg-red-500 rounded-full hover:bg-red-600 transition-colors shadow-lg z-10"
//                   >
//                     <X className="w-4 h-4 text-white" />
//                   </button>
//                 </div>
//               ))}
//             </div>
//           </div>
//         )}
//       </div>

//       {/* Fixed Bottom Button */}
//       <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
//         <div className="max-w-md mx-auto">
//           <button
//             onClick={handleSubmit}
//             disabled={capturedImages.length === 0}
//             className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-semibold py-4 rounded-xl transition-all disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md active:scale-98"
//           >
//             <Upload className="w-5 h-5" />
//             Submit Complaint
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// };

// export default AddComplaint;



import React, { useState, useRef } from 'react';
import { ArrowLeft, Camera, Image as ImageIcon, X, Upload, ZoomIn, ChevronLeft, ChevronRight } from 'lucide-react';
import CameraCapture from '../cameraCapture';
import { useNavigate } from 'react-router-dom';
import { CreateComplaint } from '../../services/addComplaints';
import { PuffLoader } from 'react-spinners';
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

interface ComplaintScreenProps {

}

interface CapturedImage {
  id: string;
  preview: string;  // base64 for preview
  file: File;       // actual File object for upload
}

const ComplaintScreen: React.FC<ComplaintScreenProps> = () => {
  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [responseText, setResponseText] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewModal, setPreviewModal] = useState<{ show: boolean; index: number }>({
    show: false,
    index: 0
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const onBack = () => {
    navigate(-1);
  }


  console.log('Captured Images:', capturedImages);

  // Convert base64 to File object
  const base64ToFile = (base64: string, filename: string, mimeType: string = 'image/jpeg'): File => {
    const arr = base64.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || mimeType;
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);

    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }

    return new File([u8arr], filename, { type: mime });
  };

  // Handle captured image from camera
  const handleCapturedImage = (imageDataUrl: string) => {
    const timestamp = Date.now();
    const filename = `captured_${timestamp}.jpg`;
    const file = base64ToFile(imageDataUrl, filename, 'image/jpeg');

    const newImage: CapturedImage = {
      id: `img_${timestamp}`,
      preview: imageDataUrl,
      file: file
    };

    setCapturedImages(prev => [...prev, newImage]);
    setShowCamera(false);
  };

  // Handle gallery upload
  const handleGalleryUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const timestamp = Date.now();
          const newImage: CapturedImage = {
            id: `img_${timestamp}_${Math.random()}`,
            preview: reader.result as string,
            file: file
          };
          setCapturedImages(prev => [...prev, newImage]);
        };
        reader.readAsDataURL(file);
      });
    }
  };

  // Remove image
  const removeImage = (index: number) => {
    setCapturedImages(prev => prev.filter((_, i) => i !== index));
    // Close modal if the removed image was being previewed
    if (previewModal.show && previewModal.index === index) {
      setPreviewModal({ show: false, index: 0 });
    } else if (previewModal.show && previewModal.index > index) {
      setPreviewModal(prev => ({ ...prev, index: prev.index - 1 }));
    }

    setResponseText(null); // Clear response text when an image is removed
  };

  // Open preview modal
  const openPreview = (index: number) => {
    setPreviewModal({ show: true, index });
  };

  // Close preview modal
  const closePreview = () => {
    setPreviewModal({ show: false, index: 0 });
  };

  // Navigate to previous image
  const previousImage = () => {
    setPreviewModal(prev => ({
      ...prev,
      index: prev.index > 0 ? prev.index - 1 : capturedImages.length - 1
    }));
  };

  // Navigate to next image
  const nextImage = () => {
    setPreviewModal(prev => ({
      ...prev,
      index: prev.index < capturedImages.length - 1 ? prev.index + 1 : 0
    }));
  };


  const handleSubmit = async () => {

    setIsSubmitting(true);
    // Validate image exists
    if (!capturedImages || capturedImages.length === 0) {
      alert("Please capture or upload at least one image");
      return;
    }

    const firstImage = capturedImages[0]?.file;

    // Validate file object
    if (!firstImage || !(firstImage instanceof File)) {
      alert("Invalid image file");
      return;
    }

    try {
      const formData = new FormData();

      // ✅ Send only first image
      formData.append("image", firstImage);

      console.log("Submitting complaint:");
      console.log("Filename:", firstImage.name);
      console.log("Size:", (firstImage.size / 1024).toFixed(2), "KB");
      console.log("Type:", firstImage.type);

      console.log(`FormData ${formData} entries`);

      console.log(firstImage);
      console.log("Type:", typeof firstImage);
      console.log("Instance of File:", firstImage instanceof File);


      const res = await CreateComplaint(formData);

      console.log("Complaint submitted successfully:", res);

      if (res?.results?.[0]?.text) {
        // alert(res.results[0].text);
        setResponseText(res.results[0].text);
      }
      else if (res?.results && Array.isArray(res.results) && res.results.length === 0) {
        toast.error("Content not detected. Please try again.");
      }
      else{
        toast.error("Failed. Please try again.");
      }

      setIsSubmitting(false);

      // Reset state
      // setCapturedImages([]);
      // onBack();

    } catch (error) {
      console.error("Error submitting complaint:", error);
      // alert("Failed to submit complaint. Please try again.");
      toast.error("Failed to submit complaint. Please try again.");
      setIsSubmitting(false);
    }
  };


  // Handle keyboard navigation in preview
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!previewModal.show) return;

    if (e.key === 'ArrowLeft') {
      previousImage();
    } else if (e.key === 'ArrowRight') {
      nextImage();
    } else if (e.key === 'Escape') {
      closePreview();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50" onKeyDown={handleKeyDown} tabIndex={0}>

      <ToastContainer
        position="top-right"
        autoClose={4000}
        hideProgressBar={false}
        newestOnTop={false}
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="light"
      />

      {/* Loader */}
      {isSubmitting && (
        <div className="fixed inset-0 z-[100] bg-black bg-opacity-40 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-white p-8 rounded-2xl shadow-xl flex flex-col items-center gap-4">
            <PuffLoader color="#3B82F6" size={60} />
            <p className="text-gray-700 font-medium">
              Submitting Complaint...
            </p>
          </div>
        </div>
      )}


      {/* Show Camera Capture Screen */}
      {showCamera && (
        <CameraCapture
          onCapture={handleCapturedImage}
          onClose={() => setShowCamera(false)}
        />
      )}

      {/* Image Preview Modal */}
      {previewModal.show && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-95 flex items-center justify-center">
          <div className="relative w-full h-full flex items-center justify-center p-4">
            {/* Close Button */}
            <button
              onClick={closePreview}
              className="absolute top-4 right-4 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
            >
              <X className="w-6 h-6 text-white" />
            </button>

            {/* Image Counter */}
            <div className="absolute top-4 left-4 px-4 py-2 bg-black bg-opacity-60 rounded-full z-10 backdrop-blur-sm">
              <p className="text-white text-sm font-medium">
                {previewModal.index + 1} / {capturedImages.length}
              </p>
            </div>

            {/* Previous Button */}
            {capturedImages.length > 1 && (
              <button
                onClick={previousImage}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
              >
                <ChevronLeft className="w-8 h-8 text-white" />
              </button>
            )}

            {/* Image */}
            <img
              src={capturedImages[previewModal.index].preview}
              alt={`Preview ${previewModal.index + 1}`}
              className="max-w-full max-h-full object-contain"
            />

            {/* Next Button */}
            {capturedImages.length > 1 && (
              <button
                onClick={nextImage}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-white bg-opacity-20 hover:bg-opacity-30 rounded-full transition-all z-10 backdrop-blur-sm"
              >
                <ChevronRight className="w-8 h-8 text-white" />
              </button>
            )}

            {/* Delete Button */}
            <button
              onClick={() => {
                removeImage(previewModal.index);
                if (capturedImages.length === 1) {
                  closePreview();
                }
              }}
              className="absolute bottom-20 md:bottom-8 left-1/2 -translate-x-1/2 px-6 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full transition-all z-10 shadow-lg flex items-center gap-2"
            >
              <X className="w-5 h-5" />
              Delete Image
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-gray-700" />
          </button>
          <h1 className="text-xl md:text-2xl font-semibold text-gray-800">
            Raise Complaint
          </h1>
        </div>
      </div>

      <div className="max-w-md mx-auto p-4 pb-24">
        {/* Upload Options */}
        <div className="space-y-4 mb-6">
          {/* Capture from Camera */}
          <button
            onClick={() => {
              setShowCamera(true);
              setCapturedImages([]);
              setResponseText(null);
            }}
            className="w-full bg-white rounded-xl shadow-md hover:shadow-lg transition-all p-6 border-2 border-gray-100 hover:border-blue-300 active:scale-98"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-blue-500 rounded-full flex items-center justify-center">
                <Camera className="w-6 h-6 text-white" />
              </div>
              <div className="text-left flex-1">
                <h3 className="text-lg font-semibold text-gray-800">
                  Capture & Upload
                </h3>
                <p className="text-sm text-gray-500">
                  Take a photo using camera
                </p>
              </div>
            </div>
          </button>

          {/* Upload from Gallery */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full bg-white rounded-xl shadow-md hover:shadow-lg transition-all p-6 border-2 border-gray-100 hover:border-blue-300 active:scale-98"
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center">
                <ImageIcon className="w-6 h-6 text-white" />
              </div>
              <div className="text-left flex-1">
                <h3 className="text-lg font-semibold text-gray-800">
                  Upload from Gallery
                </h3>
                <p className="text-sm text-gray-500">
                  Choose from your photos
                </p>
              </div>
            </div>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleGalleryUpload}
            className="hidden"
          />
        </div>

        {/* Image Preview Grid */}
        {capturedImages.length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-3">
              Preview
              {/* ({capturedImages.length}) */}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {capturedImages.map((image, index) => (
                <div key={image.id} className="relative group">
                  <button
                    onClick={() => openPreview(index)}
                    className="w-full h-40 relative rounded-lg overflow-hidden border-2 border-gray-200 hover:border-blue-400 transition-all"
                  >
                    <img
                      src={image.preview}
                      alt={`Captured ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    {/* Zoom overlay on hover */}
                    <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all flex items-center justify-center">
                      <ZoomIn className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-all" />
                    </div>
                    {/* File info badge */}
                    <div className="absolute bottom-2 left-2 px-2 py-1 bg-black bg-opacity-70 rounded text-xs text-white">
                      {image.file.type.includes('jpeg') || image.file.type.includes('jpg') ? 'JPG' : 'PNG'}
                      <span className="ml-1 opacity-70">
                        {(image.file.size / 1024).toFixed(0)}KB
                      </span>
                    </div>
                  </button>

                  {/* Remove button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(index);
                    }}
                    className="absolute top-2 right-2 p-1.5 bg-red-500 rounded-full hover:bg-red-600 transition-colors shadow-lg z-10"
                  >
                    <X className="w-4 h-4 text-white" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Response Text */}
        {responseText && (
          <div className="mb-6 rounded-xl border border-emerald-300 bg-emerald-50 shadow-sm p-5 transition-all duration-300 animate-fadeIn">

            <div className="flex items-start gap-3">

              {/* Success Icon */}
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center shadow-md">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>

              {/* Content */}
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-emerald-800 mb-1">
                  {/* Success Response */} Result
                </h3>
                <p className="text-emerald-700 leading-relaxed">
                  {responseText}
                </p>
              </div>

            </div>
          </div>
        )}


      </div>

      {/* Fixed Bottom Button */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 shadow-lg">
        <div className="max-w-md mx-auto">
          <button
            onClick={handleSubmit}
            disabled={capturedImages.length === 0 || isSubmitting}
            className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-semibold py-4 rounded-xl transition-all disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md active:scale-98"
          >
            <Upload className="w-5 h-5" />
            {isSubmitting ? 'Submitting...' : 'Submit Complaint'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ComplaintScreen;