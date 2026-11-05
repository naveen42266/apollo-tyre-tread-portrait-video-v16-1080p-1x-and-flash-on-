import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { Screen } from "./types";

interface ScreenState {
  currentScreen: Screen;
}

const initialState: ScreenState = {
  currentScreen: "DASHBOARD",
};

const screenSlice = createSlice({
  name: "screen",
  initialState,
  reducers: {
    setScreen: (state, action: PayloadAction<Screen>) => {
      state.currentScreen = action.payload;
    },
  },
});

export const { setScreen } = screenSlice.actions;
export default screenSlice.reducer;
