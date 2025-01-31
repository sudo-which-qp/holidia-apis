import { Elysia, error, t } from "elysia";
import { authPlugin } from "~/middleware/auth";
import { db } from "~/db";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-11-20.acacia",
});

const BookingInput = t.Object({
  property_id: t.String(),
  check_in: t.String(),
  check_out: t.String(),
  guest_count: t.Number(),
  special_requests: t.Optional(t.String()),
});

export const bookingRouter = new Elysia()
  .use(authPlugin)
  .post(
    "bookings/",
    async ({ body, user }) => {
      console.log(body);
      console.log("incoming request");
      const check_in = new Date(body.check_in);
      const check_out = new Date(body.check_out);

      // Validate dates
      if (check_in > check_out) {
        console.log("check_in", check_in);
        throw error(400, "Check-out must be after check-in");
      }

      const property = await db.property.findUnique({
        where: { id: body.property_id },
      });

      if (!property) {
        throw error(404, "Property not found");
      }

      const existingBooking = await db.booking.findFirst({
        where: {
          property_id: body.property_id,
          OR: [
            {
              AND: [
                { check_in: { lte: check_out } },
                { check_out: { gte: check_in } },
              ],
            },
          ],
          NOT: {
            OR: [{ status: "cancelled" }, { payment_status: "failed" }],
          },
        },
      });

      if (existingBooking) {
        throw error(409, "Property is not available for these dates");
      }

      const nights =
        Math.ceil(
          (check_out.getTime() - check_in.getTime()) / (1000 * 60 * 60 * 24)
        ) + 1;
      const total_price = property.price_per_night * nights;

      try {
        const customer = await stripe.customers.create({
          name: user.name,
          email: user.email,
        });

        const ephemeralKey = await stripe.ephemeralKeys.create(
          { customer: customer.id },
          { apiVersion: "2024-11-20.acacia" }
        );

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(total_price * 100),
          currency: "inr",
          customer: customer.id,
          payment_method_types: ["card"],
          metadata: {
            property_id: property.id,
            user_id: user.id,
            nights: nights.toString(),
          },
        });

        const booking = await db.booking.create({
          data: {
            property_id: body.property_id,
            user_id: user.id,
            check_in,
            check_out,
            total_price,
            status: "pending",
            guest_count: body.guest_count,
            special_requests: body.special_requests,
            payment_intent_id: paymentIntent.id,
            payment_status: "pending",
          },
          include: {
            property: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                avatar: true,
              },
            },
          },
        });

        return {
          message: "Booking created successfully",
          booking_id: booking.id,
          clientSecret: paymentIntent.client_secret,
          ephemeralKey: ephemeralKey.secret,
          customerId: customer.id,
          paymentIntent: paymentIntent.client_secret,
        };
      } catch (err) {
        throw error(500, "Failed to process payment setup");
      }
    },
    {
      body: BookingInput,
    }
  )
  .get(
    "/users/bookings",
    async ({ query, user }) => {
      const page = Number(query?.page || 1);
      const pageSize = Number(query?.pageSize || 10);
      const skip = (page - 1) * pageSize;

      const [bookings, totalCount] = await Promise.all([
        db.booking.findMany({
          where: {
            user_id: user.id,
          },
          include: {
            property: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                avatar: true,
              },
            },
            review: true,
          },
          skip,
          take: pageSize,
          orderBy: {
            created_at: "desc",
          },
        }),
        db.booking.count({
          where: {
            user_id: user.id,
          },
        }),
      ]);

      return {
        bookings,
        totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
      }),
    }
  )
  .get("bookings/:id", async ({ params: { id }, user }) => {
    const booking = await db.booking.findUnique({
      where: { id },
      include: {
        property: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            avatar: true,
          },
        },
        review: true,
      },
    });

    if (!booking) {
      throw error(404, "Booking not found");
    }

    if (booking.user_id !== user.id) {
      throw error(403, "Not authorized to view this booking");
    }

    return { booking };
  })
  .patch(
    "bookings/:id",
    async ({ params: { id }, body, user }) => {
      const booking = await db.booking.findUnique({
        where: { id },
        include: {
          property: true,
        },
      });

      if (!booking) {
        throw error(404, "Booking not found");
      }

      if (booking.user_id !== user.id) {
        throw error(403, "Not authorized to update this booking");
      }

      if (booking.status === "completed" || booking.status === "cancelled") {
        throw error(400, "Cannot modify completed or cancelled bookings");
      }

      let newTotalPrice = booking.total_price;
      let updateData: any = {};

      if (body.check_in || body.check_out) {
        const check_in = new Date(body.check_in || booking.check_in);
        const check_out = new Date(body.check_out || booking.check_out);

        if (check_in >= check_out) {
          throw error(400, "Check-out must be after check-in");
        }

        const existingBooking = await db.booking.findFirst({
          where: {
            property_id: booking.property_id,
            id: { not: id },
            OR: [
              {
                AND: [
                  { check_in: { lte: check_out } },
                  { check_out: { gte: check_in } },
                ],
              },
            ],
            NOT: {
              OR: [{ status: "cancelled" }, { payment_status: "failed" }],
            },
          },
        });

        if (existingBooking) {
          throw error(409, "Property is not available for these dates");
        }

        const nights =
          Math.ceil(
            (check_out.getTime() - check_in.getTime()) / (1000 * 60 * 60 * 24)
          ) + 1;
        newTotalPrice = booking.property.price_per_night * nights;

        updateData = {
          ...updateData,
          check_in,
          check_out,
          total_price: newTotalPrice,
        };
      }

      if (body.guest_count) {
        updateData.guest_count = body.guest_count;
      }

      if (body.special_requests) {
        updateData.special_requests = body.special_requests;
      }

      const updatedBooking = await db.booking.update({
        where: { id },
        data: updateData,
        include: {
          property: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
              avatar: true,
            },
          },
          review: true,
        },
      });

      // If price changed, update payment intent
      if (newTotalPrice !== booking.total_price) {
        try {
          if (!booking.payment_intent_id) {
            return error(400, "Payment intent not found");
          }
          await stripe.paymentIntents.update(booking.payment_intent_id, {
            amount: Math.round(newTotalPrice * 100),
          });
        } catch (err) {
          throw error(500, "Failed to update payment amount");
        }
      }

      return {
        message: "Booking updated successfully",
        booking: updatedBooking,
      };
    },
    {
      body: t.Partial(BookingInput),
    }
  )
  .delete("bookings/:id", async ({ params: { id }, user }) => {
    const booking = await db.booking.findUnique({
      where: { id },
    });

    if (!booking) {
      throw error(404, "Booking not found");
    }

    if (booking.user_id !== user.id) {
      throw error(403, "Not authorized to delete this booking");
    }

    if (booking.status === "completed") {
      throw error(400, "Cannot delete completed bookings");
    }

    try {
      if (booking.payment_intent_id && booking.payment_status === "pending") {
        await stripe.paymentIntents.cancel(booking.payment_intent_id);
      }

      await db.booking.update({
        where: { id },
        data: {
          status: "cancelled",
          payment_status: "cancelled",
        },
      });

      return {
        message: "Booking cancelled successfully",
      };
    } catch (err) {
      throw error(500, "Failed to cancel booking");
    }
  });
