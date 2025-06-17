const dotenv = require('dotenv');

dotenv.config();

module.exports = {
  networkFee: process.env.NETWORK_FEE ? parseFloat(process.env.NETWORK_FEE) : 0.1,
  networkTollTax: process.env.NETWORK_TOLL_TAX ? parseFloat(process.env.NETWORK_TOLL_TAX) : 0.01
};