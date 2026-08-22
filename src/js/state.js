// Simple state machine for the UI
export const state = {
  currentStage: 1,
  profileName: 'default_profile',
  instrument: null,
  
  update(newState) {
    Object.assign(this, newState);
    this.render();
  },
  
  render() {
    // Reactive UI updates go here
    console.log('State updated:', this);
  }
};
