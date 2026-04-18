const mongoose = require('mongoose');

const RequestSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true },
    phone:       { type: String, required: true, trim: true },
    address:     { type: String, required: true, trim: true },
    landmark:    { type: String, default: '', trim: true },
    serviceType: { type: String, default: 'Other', trim: true },
    description: { type: String, default: '', trim: true },
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    status: {
      type: String,
      enum: ['pending', 'in-progress', 'completed'],
      default: 'pending',
    },
    assignedTo: { type: String, default: null },
    notes:      { type: String, default: '' },
  },
  { timestamps: true }
);

// Virtual `id` field so frontend gets `id` instead of `_id`
RequestSchema.set('toJSON', {
  virtuals: true,
  transform: (_, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Request', RequestSchema);
