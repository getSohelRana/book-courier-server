const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const generateTrackingId = require("./utils/generateTrackingId");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

//middleware
app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.hvoghur.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("book_courier_db");
    const usersCollection = db.collection("users");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const paymentsCollection = db.collection("payments");
    // POST : users api
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        const { email } = user;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email is required",
          });
        }

        const existingUser = await usersCollection.findOne({ email });

        if (existingUser) {
          return res.status(409).send({
            success: false,
            message: "User already registered",
          });
        }

        const newUser = {
          ...user,
          role: "user",
          createdAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);

        res.status(201).send({
          success: true,
          message: "User created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to create user",
        });
      }
    });

    // get single books by id
    app.get("/book-details/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const book_details = await booksCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!book_details) {
          return res.status(404).json({
            success: false,
            message: "Book not found",
          });
        }
        res.status(200).json({
          success: true,
          data: book_details,
        });
      } catch (error) {
        console.error("Get Book Error:", error);

        res.status(500).json({
          success: false,
          message: "Something went wrong",
        });
      }
    });

    // PAYMENT ENDPOINT
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { orderId, price, bookName, customerEmail } = req.body;

        const order = await ordersCollection.findOne({
          _id: new ObjectId(orderId),
        });

        if (!order) {
          return res.status(404).send({ error: "Order not found" });
        }

        // Duplicate payment check
        if (order.paymentStatus === "paid") {
          return res.status(400).send({ error: "Order already paid" });
        }

        // Create Stripe session
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "usd",
                unit_amount: price * 100,
                product_data: { name: `Payment for "${bookName}"` },
              },
              quantity: 1,
            },
          ],
          metadata: { orderId: orderId.toString() },
          customer_email: customerEmail,
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe session error:", error.message);
        res.status(500).send({ error: error.message });
      }
    });

    // payment success
    app.patch("/payment-success", async (req, res) => {
      try {
        const { session_id } = req.body;

        //Validate input
        if (!session_id) {
          return res.status(400).send({ error: "Session ID missing" });
        }

        //Retrieve Stripe session
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (!session || session.payment_status !== "paid") {
          return res.status(400).send({ error: "Payment not completed" });
        }

        const orderId = session.metadata?.orderId;
        if (!orderId)
          return res
            .status(400)
            .send({ error: "Order ID missing in metadata" });

        // Fetch order
        const order = await ordersCollection.findOne({
          _id: new ObjectId(orderId),
        });
        if (!order) return res.status(404).send({ error: "Order not found" });

        // Duplicate payment check
        if (order.paymentStatus === "paid") {
          return res.status(400).send({ error: "Payment already processed" });
        }

        //Generate tracking id
        const trackingId = generateTrackingId();

        //Update order
        await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              paymentStatus: "paid",
              orderStatus: "paid",
              trackingId,
              updatedAt: new Date(),
            },
          },
        );

        //Insert payment history
        const paymentHistory = {
          orderId,
          price: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId,
          paidAt: new Date(),
        };

        await paymentsCollection.insertOne(paymentHistory);

        res.send({ success: true, trackingId });
      } catch (error) {
        console.error("Payment success error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    //GET : all users
    app.get("/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Failed to get users" });
      }
    });

    // make admin api
    app.patch("/users/admin/:id", async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role: "admin" } },
      );
      res.send(result);
    });

    //make librarian api
    app.patch("/users/librarian/:id", async (req, res) => {
      const id = req.params.id;
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role: "librarian" } },
      );
      res.send(result);
    });
    // Get all  users by role base
    app.get("/users/role/:email", async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res
            .status(404)
            .send({ success: false, message: "User not found", role: null });
        }

        res.send({ success: true, role: user.role });
      } catch (error) {
        console.error(error);
        res.status(500).send({
          success: false,
          message: "Failed to fetch user role",
          role: null,
        });
      }
    });

    // librarian api goes here
    //POST : books
    app.post("/all-books", async (req, res) => {
      try {
        const {
          bookName,
          authorName,
          category,
          description,
          pages,
          price,
          publish,
          quantity,
          coverImg,
          addedBy,
        } = req.body;

        // check duplicate
        const toLowerCaseBookName = bookName.trim().toLowerCase();
        const toLowerCaseAuthorName = authorName.trim().toLowerCase();

        // Check existing book
        const existingBook = await booksCollection.findOne({
          bookName: toLowerCaseBookName,
          authorName: toLowerCaseAuthorName,
        });

        if (existingBook) {
          // If exists => increase quantity
          const updateResult = await booksCollection.updateOne(
            { _id: existingBook._id },
            {
              $inc: { quantity: Number(quantity) },
              $set: { updatedAt: new Date() },
              $push: {
                stockHistory: {
                  addedBy,
                  quantity: Number(quantity),
                  date: new Date(),
                },
              },
            },
          );

          return res.status(200).send({
            message: "Book already exists. Quantity updated.",
            updated: true,
            updateResult,
          });
        }

        //  If not exists > insert new book
        const newBook = {
          bookName: toLowerCaseBookName,
          authorName: toLowerCaseAuthorName,
          category,
          description,
          pages: Number(pages),
          price: Number(price),
          publish,
          quantity: Number(quantity),
          coverImg,
          addedBy,
          stockHistory: [
            {
              quantity: Number(quantity),
              date: new Date(),
            },
          ],
          createdAt: new Date(),
        };

        const result = await booksCollection.insertOne(newBook);

        res.status(201).send({
          message: "New book added successfully",
          inserted: true,
          result,
        });
      } catch (error) {
        console.error("Add Book Error:", error);
        res.status(500).send({
          message: "Failed to add book",
          error: error.message,
        });
      }
    });

    // GET : all books
    app.get("/all-books", async (req, res) => {
      try {
        const all_books_data = await booksCollection
          .find({ publish: "Published" })
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json({
          success: true,
          data: all_books_data,
        });
      } catch (error) {
        console.log(error);
        res.status(500).json({
          success: false,
          message: "Fail to fetch books",
          error: error.message,
        });
      }
    });

    // ORDER : api goes here
    app.post("/orders", async (req, res) => {
      try {
        const orderData = req.body;
        const { bookId, customerEmail } = orderData;

        // Check existing order
        const existingOrder = await ordersCollection.findOne({
          bookId,
          customerEmail,
        });

        // If already ordered → increase quantity
        if (existingOrder) {
          await ordersCollection.updateOne(
            { _id: existingOrder._id },
            {
              $inc: { quantity: 1 },
              $set: {
                rating: orderData.rating,
                comment: orderData.comment,
                updatedAt: new Date(),
              },
            },
          );

          //decrease book stock
          await booksCollection.updateOne(
            { _id: new ObjectId(bookId) },
            { $inc: { quantity: -1 } },
          );

          return res.status(200).send({
            message: "Book already ordered. Quantity updated.",
            updated: true,
          });
        }

        // New order
        const newOrder = {
          ...orderData,
          quantity: 1,
          orderStatus: "pending",
          paymentStatus: "unpaid",
          createdAt: new Date(),
        };

        const result = await ordersCollection.insertOne(newOrder);

        // decrease book stock
        await booksCollection.updateOne(
          { _id: new ObjectId(bookId) },
          { $inc: { quantity: -1 } },
        );

        res.send({
          success: true,
          insertedId: result.insertedId,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Order failed",
        });
      }
    });

    // GET : get order by email
    app.get("/my-order", async (req, res) => {
      try {
        const email = req.query.email;
        const orders = await ordersCollection
          .find({ customerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(orders);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server Error" });
      }
    });

    //GET : get order by id
    app.get("/orders/:bookId", async (req, res) => {
      try {
        const bookId = req.params.bookId;

        const reviews = await ordersCollection
          .find({
            bookId: bookId,
            rating: { $exists: true },
            comment: { $exists: true },
          })
          .toArray();

        res.send({
          success: true,
          data: reviews,
        });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    });
    // DELETE : delete order by id
    app.delete("/orders/:id", async (req, res) => {
      const id = req.params.id; // use params instead of body
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });
    // GET : get single data for payment
    app.get("/payment/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!result) {
          return res.status(404).send({ message: "Order not found" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error retrieving order", error });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Book courier connected successfully");
});

app.listen(port, () => {
  console.log(`book-courier server is running on port: ${port}`);
});
