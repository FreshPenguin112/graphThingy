// Import the actual sampler modules to test
import('./sampler.js').then(sampler => {
  console.log('Module loaded');
  // The functions aren't exported, but let's check what's available
  console.log('Keys:', Object.keys(sampler).filter(k => typeof sampler[k] === 'function').join(', '));
}).catch(err => console.error(err));