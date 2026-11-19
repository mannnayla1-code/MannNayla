import antiScamButtonsHandler from '../../../handlers/antiScamButtons.js';

export default [
  {
    name: 'antiscam_toggle',
    execute: antiScamButtonsHandler.execute,
  },
  {
    name: 'antiscam_refresh',
    execute: antiScamButtonsHandler.execute,
  },
  {
    name: 'antiscam_timeout',
    execute: antiScamButtonsHandler.execute,
  },
];
