(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const User = mongoose.model('User'); // you already define this in server.js
  await User.updateMany(
    { infiniteFlightUsername: { $exists: false } },
    { $set: { infiniteFlightUsername: "" } }
  );
  console.log("Backfill done");
  process.exit();
})();
