import { BASE_URL } from "../config";

export const CreateComplaint = async (formData: FormData) => {
  try {
    const response = await fetch(`${BASE_URL}/process`, {
      method: "POST",
      body: formData, // ⚠️ Do NOT set Content-Type manually
    });

    if (!response.ok) {
      throw new Error("Failed to create complaint");
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
};
